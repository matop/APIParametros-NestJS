import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PersistenciaService } from '@andestec/persistencia-redis/nestjs';
import { DispositivoService } from '@andestec/api-dispositivos';
import { ConsumoParametrosService } from './consumo-parametros.service';
import {
  REPOSITORIO_PARAMETROS,
  VIGENCIA_VALORES_MS_DEFAULT,
  BREAKER_NET_S_DEFAULT,
  DEF_THROTTLE_S_DEFAULT,
  SEPARADOR_SUFIJO,
  TIPO_DEFINICION_NEGOCIO,
  TIPO_DEFINICION_DISPOSITIVO,
  MODO_WEBAPP,
  contextId,
  tagDefinicion,
  tagEstructura,
  tagNotificacion,
  tagOffline,
} from '../constants';
import type {
  ContextoParametro,
  OpcionesResultadoParametro,
  ParametroDefinicion,
  ParametroEstructura,
  ParametroValueItem,
  ResultadoParametro,
} from '../interfaces';

/**
 * API Parámetros: primitivas GetParametro / InicializaParametrosDispositivo /
 * InicializaParametrosNegocio, portadas del KB GeneXus con caché SOLO en Redis
 * (@andestec/persistencia-redis) y valores en JSON.
 *
 * Modelo en Redis (repositorio "Parametros2410"):
 *  - Valores:    llave = contextId(app, empKey, alcance)  → ParametroValueItem[]
 *  - Definición: llave = "Definicion" + ParametroId        → ParametroDefinicion
 *  - Estructura: llave = "Estructura" + EstructuraId        → ParametroEstructura
 *  - Vigencia:   llave = "Vigencia"  + contextId(scope)     → epoch ms del último refresco
 *
 * NOTA: agrupar los valores por el `ParametroMaxAlcance` de CADA parámetro (no bajo
 * un único contexto) es una reconstrucción fiel del camino de lectura del KB; conviene
 * validarla con un refresco real cuando el backend esté disponible.
 */
@Injectable()
export class ParametrosService {
  private readonly logger = new Logger(ParametrosService.name);

  /**
   * Caché en proceso de valores resueltos (incluye "miss" = valor vacío), estilo
   * el tier RAM del KB. Clave `contextId|base` → { valor, finMs }. Acotada por la
   * ventana de frescura (PARAM_VIGENCIA_MS) y limpiada al refrescar (Inicializa),
   * para que un valor agregado no quede oculto más allá de esa ventana.
   */
  private readonly memoValores = new Map<
    string,
    { valor: string; encontrado: boolean; finMs: number }
  >();

  /** Caché en proceso de definiciones (incluye negativos "NoExiste" = null). */
  private readonly memoDefiniciones = new Map<string, ParametroDefinicion | null>();

  /** Disponibilidad observada durante la inicialización del proceso actual. */
  private readonly estadoValoresPorContexto = new Map<string, 'available' | 'unavailable'>();
  private readonly estadoDefinicionesPorAplicacion = new Map<string, 'available' | 'unavailable'>();

  /**
   * Última notificación de refresco YA consumida por este proceso, por scope
   * (llave de notificación → epoch ms de la marca en Redis). Permite que cada
   * instancia refresque una vez por notificación nueva, sin "consumir" (borrar)
   * el flag compartido en Redis (a diferencia del KB, que era mono-proceso).
   */
  private readonly notificacionesConsumidas = new Map<string, number>();

  constructor(
    private readonly config: ConfigService,
    private readonly persistencia: PersistenciaService,
    private readonly dispositivo: DispositivoService,
    private readonly consumo: ConsumoParametrosService,
  ) {}

  // ============================== Primitiva GetParametro ==============================

  /**
   * Obtiene el valor de un parámetro para el contexto dado.
   * @param parametroId Id del parámetro; admite sufijo compuesto `base_sufijo`.
   * @param contexto Contexto explícito (aplicacionId/empKey/alcanceId/ambienteId/modo).
   *                 Se completan defaults desde el entorno.
   * @returns El valor (string). "" si no existe / no vigente.
   */
  async GetParametro(parametroId: string, contexto: Partial<ContextoParametro>): Promise<string> {
    const resultado = await this.GetParametroResultado(parametroId, contexto);
    return resultado.estado === 'configured' || resultado.estado === 'last-known-valid'
      ? resultado.valor
      : '';
  }

  async GetParametroResultado(
    parametroId: string,
    contexto: Partial<ContextoParametro>,
  ): Promise<ResultadoParametro<string>>;
  async GetParametroResultado<T>(
    parametroId: string,
    contexto: Partial<ContextoParametro>,
    opciones: OpcionesResultadoParametro<T>,
  ): Promise<ResultadoParametro<T>>;
  async GetParametroResultado<T = string>(
    parametroId: string,
    contexto: Partial<ContextoParametro>,
    opciones?: OpcionesResultadoParametro<T>,
  ): Promise<ResultadoParametro<T | string>> {
    const ctx = this.normalizarContexto(contexto);
    const ahora = new Date();

    // 1+2) Resolver base/sufijo + definición. Los ParametroId pueden contener "_"
    // (p.ej. "PI_TipoDefault"), así que se intenta PRIMERO el id completo como
    // parámetro y, solo si no existe, se separa por el ÚLTIMO "_" (base_sufijo)
    // para valores compuestos.
    let base = parametroId;
    let sufijo = '';
    let def = await this.obtenerDefinicion(base);
    if (!def && parametroId.includes(SEPARADOR_SUFIJO)) {
      const i = parametroId.lastIndexOf(SEPARADOR_SUFIJO);
      base = parametroId.slice(0, i);
      sufijo = parametroId.slice(i + 1);
      def = await this.obtenerDefinicion(base);
    }
    if (!def) {
      this.logger.warn(`GetParametro: sin definición para "${parametroId}". ¿Se llamó a Inicializa*?`);
      return this.estadoDefinicionesPorAplicacion.get(ctx.aplicacionId) === 'available'
        ? { estado: 'not-configured' }
        : { estado: 'source-unavailable' };
    }

    // 3) Resolver alcance según TipoDefinicionId ("Neg" = negocio, "Disp" = dispositivo).
    const alcance = this.resolverAlcance(def, ctx);
    if (alcance === null) return { estado: 'source-unavailable' };

    // 4) La persistencia se indexa por el contexto COMPLETO (App, EmpKey, Alcance),
    //    igual que el KB (getparametro.java líneas 185-192). La jerarquía
    //    (aplicación/empresa/dispositivo) la resuelve el backend al consultar con
    //    ese (EmpKey, Alcance); aquí solo leemos el valor ya resuelto.
    const claveContexto = contextId(ctx.aplicacionId, ctx.empKey, alcance);

    // 5) Valor base: primero la caché en proceso (incluye "miss" cacheado); si no,
    //    leer el blob de Redis, resolver el vigente y memorizar.
    const nowMs = ahora.getTime();
    const techoMs = nowMs + this.vigenciaMs(); // la caché no vive más que la ventana de frescura
    const memoKey = `${claveContexto}|${base}`;
    let valor: string;
    let encontrado: boolean;

    const cache = this.memoValores.get(memoKey);
    if (cache && cache.finMs > nowMs) {
      valor = cache.valor;
      encontrado = cache.encontrado;
    } else {
      const items = await this.leerValoresContexto(claveContexto);
      const item = this.seleccionarValorVigente(items, base, ahora);
      valor = item?.ValorParametroValor ?? '';
      encontrado = item !== null;
      // Hit: hasta el Fin del valor, pero sin exceder la ventana de frescura.
      // Miss (valor vacío): hasta el fin de la ventana de frescura (NO 1 día).
      let finMs = techoMs;
      if (valor) {
        const finReal = this.aEpoch(item?.ValorParametroFin, Infinity);
        finMs = Math.min(Number.isFinite(finReal) ? finReal : techoMs, techoMs);
      }
      this.memoValores.set(memoKey, { valor, encontrado, finMs });
    }

    const fuenteNoDisponible =
      this.estadoValoresPorContexto.get(claveContexto) === 'unavailable';
    if (!encontrado) {
      return fuenteNoDisponible || !this.estadoValoresPorContexto.has(claveContexto)
        ? { estado: 'source-unavailable' }
        : { estado: 'not-configured' };
    }
    if (!valor) return { estado: 'invalid-value' };

    // 6) Si hay sufijo, extraer el componente del valor compuesto.
    if (sufijo) {
      valor = await this.obtenerValorxIndice(valor, sufijo, def);
      if (!valor) return { estado: 'invalid-value' };
    }

    let valorDecodificado: T | string = valor;
    if (opciones) {
      const decodificado = opciones.decodificar(valor);
      if (!decodificado.valido) return { estado: 'invalid-value' };
      valorDecodificado = decodificado.valor;
    }

    return fuenteNoDisponible
      ? {
          estado: 'last-known-valid',
          valor: valorDecodificado,
          causa: 'source-unavailable',
        }
      : { estado: 'configured', valor: valorDecodificado };
  }

  // ===================== Primitiva InicializaParametrosDispositivo =====================

  /**
   * Inicializa/refresca los parámetros con alcance = id del dispositivo.
   * @returns `true` si la persistencia quedó vigente.
   */
  async InicializaParametrosDispositivo(
    appId: string,
    empKey: number,
    modo: string,
  ): Promise<boolean> {
    const dispositivoId = this.dispositivo.GetDispositivoId();
    if (!dispositivoId) {
      this.logger.error('InicializaParametrosDispositivo: DispositivoId no disponible');
      return false;
    }
    return this.inicializar({ appId, empKey, alcanceId: dispositivoId, modo });
  }

  // ====================== Primitiva InicializaParametrosNegocio ======================

  /**
   * Inicializa/refresca los parámetros con alcance = id de negocio (provisto).
   * @returns `true` si la persistencia quedó vigente.
   */
  async InicializaParametrosNegocio(
    appId: string,
    empKey: number,
    alcanceId: string,
    modo: string,
  ): Promise<boolean> {
    return this.inicializar({ appId, empKey, alcanceId, modo });
  }

  // ================================ Lógica de refresco ================================

  /** Refresca definición + estructuras + valores si la persistencia no está vigente. */
  private async inicializar(scope: {
    appId: string;
    empKey: number;
    alcanceId: string;
    modo: string;
  }): Promise<boolean> {
    const { appId, empKey, alcanceId, modo } = scope;
    const scopeCtxId = contextId(appId, empKey, alcanceId);

    const debeRefrescar =
      modo === MODO_WEBAPP ||
      (await this.refrescoPorNotificacion(appId, empKey, alcanceId)) ||
      !(await this.persistenciaVigente(scopeCtxId));

    if (!debeRefrescar) {
      this.estadoValoresPorContexto.set(scopeCtxId, 'available');
      return true; // ya vigente, nada que hacer.
    }

    try {
      // AmbienteId: se obtiene desde la API de Dispositivos (GetDispositivoAmbiente).
      const ambienteId = await this.resolverAmbiente();

      // Definiciones + estructuras: solo si NO están "throttled" (cambian poco).
      const svcDef = `Definicion_${appId}`;
      if (!(await this.estaOffline(`Throttle_${svcDef}`))) {
        this.estadoDefinicionesPorAplicacion.set(appId, 'unavailable');
        const okDef = await this.actualizarDefiniciones(appId, modo);
        if (okDef) {
          this.estadoDefinicionesPorAplicacion.set(appId, 'available');
          await this.actualizarEstructuras(appId);
          await this.registrarOffline(`Throttle_${svcDef}`, this.defThrottleS());
        }
      } else {
        // El throttle sólo se registra después de una descarga exitosa.
        this.estadoDefinicionesPorAplicacion.set(appId, 'available');
      }

      // Valores: si el backend está offline (breaker), se mantiene la caché y NO se
      // marca vigente, para reintentar cuando el breaker expire.
      this.estadoValoresPorContexto.set(scopeCtxId, 'unavailable');
      const okVal = await this.actualizarValores({ appId, empKey, alcanceId, ambienteId, modo });
      if (!okVal) {
        this.logger.warn(`inicializar(${scopeCtxId}): valores no refrescados (offline); se usa caché`);
        return true;
      }

      this.estadoValoresPorContexto.set(scopeCtxId, 'available');
      await this.marcarVigente(scopeCtxId);
      this.invalidarCache(scopeCtxId);
      return true;
    } catch (error) {
      this.estadoValoresPorContexto.set(scopeCtxId, 'unavailable');
      this.logger.error(`inicializar(${scopeCtxId}): ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * GetParametroDefinicion → guarda cada definición bajo "Definicion{ParametroId}".
   * @returns `true` si se descargó; `false` si el servicio estaba offline (breaker).
   */
  private async actualizarDefiniciones(appId: string, modo: string): Promise<boolean> {
    const out = await this.remotoConBreaker(`Definicion_${appId}`, () =>
      this.consumo.getParametroDefinicion({ aplicacionIdl: appId, modo }),
    );
    if (out === null) return false;
    const defs = out.ParametrosDefinitionApp?.ParametrosItemDefinitionApp ?? [];
    for (const def of defs) {
      if (def.ParametroId) {
        await this.persistencia.set(REPOSITORIO_PARAMETROS, tagDefinicion(def.ParametroId), def);
      }
    }
    this.logger.debug(`Definiciones actualizadas: ${defs.length}`);
    return true;
  }

  /** GetDefinicionEstructuras → guarda cada estructura bajo "Estructura{EstructuraId}". */
  private async actualizarEstructuras(appId: string): Promise<boolean> {
    const out = await this.remotoConBreaker(`Estructuras_${appId}`, () =>
      this.consumo.getDefinicionEstructuras(),
    );
    if (out === null) return false;
    const estructuras = out.SDTParametroEstructura ?? [];
    for (const est of estructuras) {
      if (est.ParametroEstructuraId) {
        await this.persistencia.set(
          REPOSITORIO_PARAMETROS,
          tagEstructura(est.ParametroEstructuraId),
          est,
        );
      }
    }
    this.logger.debug(`Estructuras actualizadas: ${estructuras.length}`);
    return true;
  }

  /**
   * GetParametrosValues (ParametroId vacío = todos) → guarda TODO el conjunto bajo
   * la única clave del scope `contextId(App, EmpKey, Alcance)`, igual que el KB
   * (persistenciaparametrosupdatevalores). El backend ya resolvió la jerarquía para
   * ese (EmpKey, Alcance), así que no hay agrupación por MaxAlcance.
   */
  private async actualizarValores(scope: {
    appId: string;
    empKey: number;
    alcanceId: string;
    ambienteId: string;
    modo: string;
  }): Promise<boolean> {
    const { appId, empKey, alcanceId, ambienteId, modo } = scope;

    const out = await this.remotoConBreaker(`Valores_${appId}`, () =>
      this.consumo.getParametrosValues({
        empKey,
        parametroId: '',
        alcanceId,
        ambienteId, // obtenido desde la API de Dispositivos (GetDispositivoAmbiente).
        aplicacionIdl: appId,
        modo,
      }),
    );
    if (out === null) return false;
    const items = out.ParametrosValuesApp?.ParametroValueArray ?? [];

    const clave = contextId(appId, empKey, alcanceId);
    await this.persistencia.set(REPOSITORIO_PARAMETROS, clave, items);
    this.logger.debug(`Valores actualizados: ${items.length} bajo ${clave}`);
    return true;
  }

  // ================================ Helpers de contexto ================================

  /**
   * Resuelve el AmbienteId desde la API de Dispositivos (`GetDispositivoAmbiente`).
   * Si se pasa un override no vacío, se respeta. Ante fallo devuelve "" (como el
   * cliente original, que enviaba ambiente vacío).
   */
  private async resolverAmbiente(override?: string): Promise<string> {
    if (override) return override;
    try {
      const amb = await this.dispositivo.GetDispositivoAmbiente();
      if (amb) return amb;
      this.logger.warn('resolverAmbiente: GetDispositivoAmbiente devolvió vacío; se usa ""');
    } catch (error) {
      this.logger.warn(`resolverAmbiente: ${(error as Error).message}; se usa ""`);
    }
    return '';
  }

  /** Completa el contexto con defaults del entorno. */
  private normalizarContexto(parcial: Partial<ContextoParametro>): ContextoParametro {
    return {
      aplicacionId: parcial.aplicacionId ?? this.config.get<string>('PARAM_APLICACION_ID') ?? '',
      empKey: parcial.empKey ?? 0,
      alcanceId: parcial.alcanceId ?? '',
      ambienteId: parcial.ambienteId ?? '',
      modo: parcial.modo ?? this.config.get<string>('PARAM_MODO') ?? '',
    };
  }

  /**
   * Alcance efectivo según TipoDefinicionId:
   *  - "Neg"  → alcance de negocio (viene en el contexto).
   *  - "Disp" → id del dispositivo.
   * Devuelve `null` si no puede resolverse.
   */
  private resolverAlcance(def: ParametroDefinicion, ctx: ContextoParametro): string | null {
    switch (def.TipoDefinicionId) {
      case TIPO_DEFINICION_NEGOCIO:
        return ctx.alcanceId;
      case TIPO_DEFINICION_DISPOSITIVO: {
        const id = this.dispositivo.GetDispositivoId();
        if (!id) {
          this.logger.warn(`resolverAlcance: DispositivoId no disponible para "${def.ParametroId}"`);
          return null;
        }
        return id;
      }
      default:
        this.logger.warn(
          `resolverAlcance: TipoDefinicionId desconocido "${def.TipoDefinicionId}" en "${def.ParametroId}"`,
        );
        return null;
    }
  }

  // ================================ Helpers de lectura ================================

  private async obtenerDefinicion(parametroId: string): Promise<ParametroDefinicion | null> {
    // Caché en proceso, con negativo "NoExiste" (null) para no re-consultar Redis.
    if (this.memoDefiniciones.has(parametroId)) {
      return this.memoDefiniciones.get(parametroId) ?? null;
    }
    const def = await this.persistencia.get<ParametroDefinicion>(
      REPOSITORIO_PARAMETROS,
      tagDefinicion(parametroId),
    );
    this.memoDefiniciones.set(parametroId, def ?? null);
    return def ?? null;
  }

  private async leerValoresContexto(claveContexto: string): Promise<ParametroValueItem[]> {
    const items = await this.persistencia.get<ParametroValueItem[]>(
      REPOSITORIO_PARAMETROS,
      claveContexto,
    );
    return Array.isArray(items) ? items : [];
  }

  /**
   * Elige el valor cuya ventana `[Ini, Fin)` contiene `ahora`.
   * NOTA: si hay varios candidatos, el KB desempata por ValorJerarquia; aquí se
   * toma el de Ini más reciente. Afinar el desempate al validar.
   */
  private seleccionarValorVigente(
    items: ParametroValueItem[],
    parametroId: string,
    ahora: Date,
  ): ParametroValueItem | null {
    const t = ahora.getTime();
    const candidatos = items
      .filter((it) => it.ParametroId === parametroId)
      .filter((it) => {
        const ini = this.aEpoch(it.ValorParametroIni, -Infinity);
        const fin = this.aEpoch(it.ValorParametroFin, Infinity);
        return ini <= t && t < fin;
      })
      .sort((a, b) => this.aEpoch(a.ValorParametroIni, -Infinity) - this.aEpoch(b.ValorParametroIni, -Infinity));
    return candidatos.length ? candidatos[candidatos.length - 1] : null;
  }

  /**
   * Convierte una fecha ISO a epoch ms. Trata como "sin límite" (`porDefecto`) los
   * casos vacío, el centinela `0000-00-00T00:00:00` del backend y las fechas inválidas.
   */
  private aEpoch(iso: string | undefined, porDefecto: number): number {
    if (!iso || iso.startsWith('0000')) return porDefecto;
    const t = new Date(iso).getTime();
    return Number.isNaN(t) ? porDefecto : t;
  }

  /**
   * Extrae un componente de un valor compuesto (equivalente a `obtenerValorxIndice`).
   * El sufijo puede ser:
   *  - el id de un componente de la Estructura (por NOMBRE), o
   *  - un índice numérico 1-based (conveniencia; el KB solo soporta por nombre).
   *
   * La Estructura se busca por `TipoParametroID` (getparametroestructura del KB:
   * `Estructura{TipoParametroID}`), y la posición lógica del componente es su lugar
   * en la lista. El valor se parte LITERALMENTE por el separador; si el separador va
   * al inicio/fin (`TipoParametroSeparadorInicioFin`) el primer elemento del split es
   * vacío, así que se aplica un offset de +1 (corrige el bug del KB, que descartaba
   * ese ajuste, y coincide con el comportamiento validado del índice numérico).
   */
  private async obtenerValorxIndice(
    valor: string,
    sufijo: string,
    def: ParametroDefinicion,
  ): Promise<string> {
    const sep = def.Separador ?? '';
    if (!sep) {
      this.logger.warn(`obtenerValorxIndice: "${def.ParametroId}" sin Separador`);
      return '';
    }

    // Posición lógica (1-based) del componente pedido.
    let posLogica: number | null = null;
    if (/^\d+$/.test(sufijo)) {
      posLogica = parseInt(sufijo, 10);
    } else {
      const est = await this.persistencia.get<ParametroEstructura>(
        REPOSITORIO_PARAMETROS,
        tagEstructura(def.TipoParametroID ?? ''),
      );
      const idx = (est?.Componente ?? []).findIndex(
        (c) => c.ParametroEstructuraComponenteId === sufijo,
      );
      posLogica = idx >= 0 ? idx + 1 : null;
    }
    if (posLogica === null || posLogica < 1) {
      this.logger.warn(`obtenerValorxIndice: sufijo "${sufijo}" no está en la estructura de "${def.ParametroId}"`);
      return '';
    }

    // Split literal + offset por separador al inicio.
    const partes = valor.split(sep);
    const idxDato = posLogica + (def.TipoParametroSeparadorInicioFin ? 1 : 0);
    if (idxDato < 1 || idxDato > partes.length) {
      this.logger.warn(`obtenerValorxIndice: posición ${posLogica} fuera de rango en "${def.ParametroId}"`);
      return '';
    }
    return partes[idxDato - 1];
  }

  // ================================ Vigencia / notificación ================================

  private vigenciaMs(): number {
    const v = Number(this.config.get('PARAM_VIGENCIA_MS'));
    return Number.isFinite(v) && v > 0 ? v : VIGENCIA_VALORES_MS_DEFAULT;
  }

  private claveVigencia(scopeCtxId: string): string {
    return `Vigencia${scopeCtxId}`;
  }

  /** ¿La persistencia del scope está dentro de la ventana de vigencia? */
  private async persistenciaVigente(scopeCtxId: string): Promise<boolean> {
    const { ok, ultimaModificacion } = await this.persistencia.check(
      REPOSITORIO_PARAMETROS,
      this.claveVigencia(scopeCtxId),
    );
    return (
      ok &&
      ultimaModificacion !== null &&
      Date.now() - ultimaModificacion.getTime() < this.vigenciaMs()
    );
  }

  private async marcarVigente(scopeCtxId: string): Promise<void> {
    await this.persistencia.set(REPOSITORIO_PARAMETROS, this.claveVigencia(scopeCtxId), Date.now());
  }

  /**
   * Limpia la caché en proceso tras un refresco (como `limpiarvaloresenram` del KB):
   * los valores memorizados del scope refrescado y todas las definiciones (que se
   * acaban de re-descargar). Así un valor recién instanciado se ve tras el refresco.
   */
  private invalidarCache(scopeCtxId: string): void {
    for (const k of this.memoValores.keys()) {
      if (k.startsWith(`${scopeCtxId}|`)) this.memoValores.delete(k);
    }
    this.memoDefiniciones.clear();
  }

  /**
   * Marca una notificación de refresco para un scope (productor).
   * El host debe llamar esto cuando reciba un push del servidor central (o tras
   * un Set de valores) para invalidar la caché del scope afectado. Equivale a
   * `NotificarRefresco` del KB, pero el flag vive en Redis (cross-instancia).
   *
   * @param aplicacionId Aplicacion_Idl.
   * @param empKey Empresa.
   * @param alcanceId Alcance afectado (id de negocio o del dispositivo).
   */
  async notificarRefresco(aplicacionId: string, empKey: number, alcanceId: string): Promise<void> {
    const llave = tagNotificacion(aplicacionId, empKey, alcanceId);
    await this.persistencia.set(REPOSITORIO_PARAMETROS, llave, Date.now());
    this.logger.debug(`notificarRefresco: marcada "${llave}"`);
  }

  /**
   * Consumidor de la notificación (usado en `inicializar`). Devuelve `true` si hay
   * una notificación MÁS NUEVA que la última consumida por este proceso para el
   * scope, y registra su marca de tiempo. NO borra el flag de Redis, para que
   * todas las instancias puedan reaccionar a la misma notificación.
   */
  private async refrescoPorNotificacion(
    aplicacionId: string,
    empKey: number,
    alcanceId: string,
  ): Promise<boolean> {
    const llave = tagNotificacion(aplicacionId, empKey, alcanceId);
    const { ok, ultimaModificacion } = await this.persistencia.check(REPOSITORIO_PARAMETROS, llave);
    if (!ok || ultimaModificacion === null) return false;

    const marca = ultimaModificacion.getTime();
    const consumida = this.notificacionesConsumidas.get(llave);
    if (consumida !== undefined && marca <= consumida) {
      return false; // ya reaccionamos a esta notificación (o a una posterior).
    }
    this.notificacionesConsumidas.set(llave, marca);
    this.logger.debug(`refrescoPorNotificacion: notificación nueva en "${llave}"`);
    return true;
  }

  // =============================== Circuit-breaker offline ===============================

  private breakerNetS(): number {
    const v = Number(this.config.get('PARAM_BREAKER_NET_S'));
    return Number.isFinite(v) && v > 0 ? v : BREAKER_NET_S_DEFAULT;
  }

  private defThrottleS(): number {
    const v = Number(this.config.get('PARAM_DEF_THROTTLE_S'));
    return Number.isFinite(v) && v >= 0 ? v : DEF_THROTTLE_S_DEFAULT;
  }

  /** ¿El servicio está marcado offline en Redis (marcador con TTL vigente)? */
  private async estaOffline(servicio: string): Promise<boolean> {
    return this.persistencia.repositorio.existe(tagOffline(servicio), REPOSITORIO_PARAMETROS);
  }

  /** Marca un servicio offline por `segundos` (marcador Redis con TTL). */
  private async registrarOffline(servicio: string, segundos: number): Promise<void> {
    if (segundos <= 0) return;
    await this.persistencia.repositorio.guardar(
      tagOffline(servicio),
      REPOSITORIO_PARAMETROS,
      { desde: Date.now(), segundos },
      { ttlSegundos: segundos },
    );
  }

  /** ¿Es un error de red (sin respuesta HTTP)? Solo estos abren el circuito. */
  private esErrorDeRed(e: unknown): boolean {
    const err = e as { response?: unknown; request?: unknown; code?: string; isAxiosError?: boolean };
    if (!err || err.response !== undefined) return false; // hubo respuesta HTTP → no es "Net"
    const codigosRed = ['ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];
    return err.isAxiosError === true || err.request !== undefined || codigosRed.includes(err.code ?? '');
  }

  /**
   * Ejecuta una llamada remota bajo el cortacircuitos:
   *  - Si el servicio está offline → devuelve `null` (omite la llamada).
   *  - Si falla por error de RED → marca offline `PARAM_BREAKER_NET_S` s y relanza.
   *  - Errores HTTP (4xx/5xx) se relanzan sin abrir el circuito.
   */
  private async remotoConBreaker<T>(servicio: string, fn: () => Promise<T>): Promise<T | null> {
    if (await this.estaOffline(servicio)) {
      this.logger.warn(`[breaker] "${servicio}" offline; se omite la llamada remota`);
      return null;
    }
    try {
      return await fn();
    } catch (e) {
      if (this.esErrorDeRed(e)) {
        await this.registrarOffline(servicio, this.breakerNetS());
        this.logger.warn(
          `[breaker] error de red en "${servicio}"; offline ${this.breakerNetS()}s: ${(e as Error).message}`,
        );
      }
      throw e;
    }
  }
}
