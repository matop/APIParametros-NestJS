# @andestec/api-parametros

API de Parámetros como **librería NestJS** de servicios inyectables (sin controladores HTTP),
port del cliente GeneXus 18 (Java). Caché **solo en Redis** vía
[`@andestec/persistencia-redis`](https://github.com/CristobalEfveliz/persistencia-redis) y
autenticación vía [`@andestec/api-dispositivos`](https://github.com/CristobalEfveliz/APIDispositivo-NestJS).
Consume el backend REST `ObtencionParametros`.

## Arquitectura

```
        ┌─────────────────────┐
        │   app anfitriona     │  importa ParametrosModule
        └──────────┬──────────┘
                   │
        ┌──────────▼──────────┐     REST (ApiKey = token dispositivo)
        │  @andestec/         │────────────────────────────────►  Backend
        │  api-parametros     │                                   ObtencionParametros
        └───┬─────────────┬───┘
            │ importa     │ importa
   ┌────────▼──────┐ ┌────▼────────────────┐
   │ api-          │ │ persistencia-redis  │──►  Redis (caché de parámetros)
   │ dispositivos  │ └─────────────────────┘
   │ (id + token + │
   │  ambiente)    │
   └───────────────┘
```

El backend **resuelve la jerarquía** (aplicación / empresa / dispositivo) según el
`(EmpKey, Alcance)` de la consulta y devuelve el valor efectivo. Esta librería lo
cachea en Redis indexado por el contexto completo `contextId(App, EmpKey, Alcance)`.

## Instalación

Se instala como dependencia, igual que las otras APIs. Desde git:

```bash
npm install git+https://github.com/CristobalEfveliz/APIParametros-NestJS.git#main
```

El paquete compila su `dist/` automáticamente al instalarse (script `prepare`).
Requiere un Redis accesible y las variables de entorno (ver [`.env.example`](.env.example)).

**Requisitos estrictos incluidos automáticamente:** `@andestec/persistencia-redis` y
`@andestec/api-dispositivos` son **dependencias directas** de este paquete, así que al
instalarlo se integran solas — no hay que instalarlas por separado. La primera aporta la
caché en Redis; la segunda, la identidad del dispositivo, el token (`ApiKey`) y el ambiente.

### Peer dependencies

El proyecto consumidor debe proveer (npm 7+ las instala automáticamente):

```
@nestjs/common  @nestjs/core  @nestjs/config  @nestjs/axios
axios  rxjs  reflect-metadata
```

### Resolución de tipos (importante)

Los tipos exportados referencian el subpath `@andestec/persistencia-redis/nestjs`
(campo `exports` de su `package.json`). Para que TypeScript lo resuelva, el
`tsconfig.json` del consumidor debe usar una resolución de módulos moderna:

```jsonc
{
  "compilerOptions": {
    "moduleResolution": "node16" // o "nodenext" / "bundler"
  }
}
```

Si el proyecto está fijado en `"moduleResolution": "node"` (clásico), añade los
mapeos `paths` equivalentes:

```jsonc
{
  "compilerOptions": {
    "baseUrl": "./",
    "paths": {
      "@andestec/persistencia-redis": [
        "./node_modules/@andestec/persistencia-redis/dist/index.d.ts"
      ],
      "@andestec/persistencia-redis/nestjs": [
        "./node_modules/@andestec/persistencia-redis/dist/nestjs/index.d.ts"
      ],
      "@andestec/api-dispositivos": [
        "./node_modules/@andestec/api-dispositivos/dist/index.d.ts"
      ]
    }
  }
}
```

## Uso

Importa el módulo una vez:

```ts
import { Module } from '@nestjs/common';
import { ParametrosModule } from '@andestec/api-parametros';

@Module({ imports: [ParametrosModule] })
export class AppModule {}
```

### Flujo: primero `Inicializa*`, luego `GetParametro`

Son **dos pasos** claramente separados:

1. **Al iniciar sesión en la aplicación**, llama a una primitiva `Inicializa*`. Estas
   consultan el backend y **pueblan la persistencia (Redis)** con las definiciones,
   estructuras y valores del contexto. Se llaman una vez por sesión (y se refrescan
   solas según la vigencia o una notificación).

   ```ts
   // Alcance de negocio (empresa/alcance provisto por el llamador):
   await this.parametros.InicializaParametrosNegocio('MiApp', 123, 'ALC-01', 'WebApp');
   // Alcance de dispositivo (el alcance = id del dispositivo):
   await this.parametros.InicializaParametrosDispositivo('MiApp', 123, 'WebApp');
   ```

2. **Durante el uso de la aplicación**, `GetParametro` **lee desde la persistencia**
   (no pega al backend): es rápido y funciona aunque el backend esté caído.

   ```ts
   const valor = await this.parametros.GetParametro('MI_PARAMETRO', {
     aplicacionId: 'MiApp',
     empKey: 123,
     alcanceId: 'ALC-01',
   });

   // Valor compuesto: sufijo por NOMBRE de componente…
   const host = await this.parametros.GetParametro('MI_LOCATION_Host', { empKey: 123 });
   // …o por índice 1-based:
   const c2 = await this.parametros.GetParametro('MI_PARAM_2', { empKey: 123 });
   ```

> Si no se llamó a `Inicializa*` para ese contexto, `GetParametro` devuelve `""`
> (no hay nada en la persistencia todavía).

Opcional — forzar refresco desde un webhook al recibir un push del servidor central:

```ts
await this.parametros.notificarRefresco('MiApp', 123, dispositivoId);
```

## API pública (`ParametrosService`)

| Método | Cuándo | Descripción |
|---|---|---|
| `InicializaParametrosNegocio(appId, empKey, alcanceId, modo)` | al iniciar sesión | Puebla/refresca la persistencia con alcance de negocio provisto. |
| `InicializaParametrosDispositivo(appId, empKey, modo)` | al iniciar sesión | Puebla/refresca la persistencia con alcance = id del dispositivo. |
| `GetParametro(parametroId, contexto)` | durante el uso | Lee el valor vigente **desde la persistencia**. Resuelve alcance por `TipoDefinicionId` (`Neg`→negocio, `Disp`→dispositivo). Sufijo compuesto `base_componente` (por nombre) o `base_indice`. |
| `GetParametroResultado(parametroId, contexto, opciones?)` | durante el uso observable | Distingue `configured`, `last-known-valid`, `not-configured`, `invalid-value` y `source-unavailable`. Un decoder opcional convierte y valida el string sin trasladar reglas de dominio al paquete. |
| `notificarRefresco(appId, empKey, alcanceId)` | webhook (opcional) | Marca un scope para refresco en el próximo `Inicializa*`. |

`GetParametro` recibe un **contexto explícito** `{ aplicacionId, empKey, alcanceId, ambienteId, modo }`
(los campos omitidos toman defaults del entorno). No usa estado global mutable.

`GetParametro` se conserva para compatibilidad: devuelve el valor en los estados
`configured`/`last-known-valid` y `""` en los demás. Los consumidores que deban
emitir warnings o tomar decisiones de fallback deben usar el resultado discriminado:

```ts
const resultado = await this.parametros.GetParametroResultado(
  'MaximoGuias',
  { aplicacionId: 'MiApp', empKey: 123, alcanceId: 'ALC-01' },
  {
    decodificar: (raw) => {
      const numero = Number(raw);
      return Number.isInteger(numero) && numero > 0
        ? { valido: true, valor: numero }
        : { valido: false };
    },
  },
);
```

## Autenticación (header `ApiKey`)

El token M2406 se genera con `@andestec/api-dispositivos` (`TokenService.TokenGen`). Su
`strControl` se arma con los MISMOS valores enviados en la query (trim + orden), porque el
backend recomputa el token para validarlo:

| Operación | `strControl` |
|---|---|
| `GetParametrosValues` | `EmpKey + ParametroId + AlcanceId + AmbienteId + Aplicacion_Idl + Modo` |
| `GetParametroDefinicion` | `Aplicacion_Idl + Modo` |
| `GetDefinicionEstructuras` | *(sin strControl → `TokenGen("")`)* |

El `AmbienteId` se obtiene de `@andestec/api-dispositivos` (`GetDispositivoAmbiente`).

## Modelo en Redis (repositorio `Parametros2410`)

- **Valores** — `Parametros2410:<contextId>` → `ParametroValueItem[]`
- **Definición** — `Parametros2410:Definicion<ParametroId>`
- **Estructura** — `Parametros2410:Estructura<EstructuraId>`
- **Vigencia** — `Parametros2410:Vigencia<contextId>` → epoch ms
- **Notificación** — `Parametros2410:NotificaActualizacion_<App>_<EmpKey>_<Alcance>`
- **Breaker** — `Parametros2410:Offline_<servicio>` (con TTL)
- `contextId = AplicacionId + zeroPad(EmpKey,6) + AlcanceId`

## Frescura, caché y resiliencia

- **Vigencia** (`PARAM_VIGENCIA_MS`, default 5 min): `Inicializa*` solo re-descarga si la
  persistencia del scope venció, si `Modo="WebApp"`, o si hubo notificación.
- **Caché en proceso**: memo de valores (incluye "miss" cacheado) y de definiciones
  (negativo `NoExiste`), acotado a la ventana de frescura y limpiado en cada refresco.
- **Invalidación por notificación push**: `notificarRefresco(...)` marca el scope en Redis;
  la siguiente `Inicializa*` lo detecta y fuerza el refresco (cross-instancia).
- **Circuit-breaker offline** (`PARAM_BREAKER_NET_S`, default 300 s): ante error de red, el
  servicio se marca offline y las siguientes llamadas se omiten (se usa la caché) hasta que
  expire. Además un throttle de definiciones (`PARAM_DEF_THROTTLE_S`, default 180 s).

## Configuración (`.env`)

Ver [`.env.example`](.env.example). Un único `.env` sirve a las tres librerías (no se
duplican variables): `REDIS_*` las lee persistencia-redis; `DISPOSITIVO_*` / `ADMIN_DISP_*`
las lee api-dispositivos; `PARAM_*` las lee esta librería.

## Scripts de prueba

En `scripts/` (requieren `.env` y Redis):

| Script | Qué prueba |
|---|---|
| `prueba-parametros.js <empKey> [alcance] [param] [modo]` | Flujo completo: ambiente, auth, Inicializa, GetParametro |
| `test-jerarquia.js` | Resolución por jerarquía (aplicación/empresa/dispositivo) |
| `test-compuestos.js` | Valores compuestos por índice |
| `test-cache-miss.js` | Caché positiva y negativa (NoExiste) |
| `test-notificacion.js` | Invalidación por notificación push |
| `test-breaker.js` | Circuit-breaker offline |

## Tests

Tests unitarios con Jest y dependencias mockeadas (no requieren backend ni Redis):

```bash
npm test
```

Cubren resolución de alcance/jerarquía, ventana de vigencia (incluido el centinela
`0000-00-00`), valores compuestos, caché de miss (positiva y negativa), condiciones de
refresco, invalidación por notificación y circuit-breaker. Los scripts de `scripts/`
(que sí pegan al backend real) sirven para pruebas de integración manuales.

## Estado / pendientes

Portadas y validadas contra backend real: `GetParametro`, `InicializaParametros*`,
jerarquía, valores compuestos por **nombre** e índice, ambiente, auth, caché de miss,
notificación push y circuit-breaker. Pendiente (opcional): operaciones de escritura
(`SetParametrosValues`, réplicas).

## Licencia

Restringido (`publishConfig.access: restricted`).
