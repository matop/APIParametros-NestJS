import { ParametrosService } from '../src/services/parametros.service';
import { contextId, tagDefinicion, REPOSITORIO_PARAMETROS } from '../src/constants';
import {
  FakePersistencia,
  fakeDispositivo,
  fakeConsumo,
  fakeConfig,
  valor,
  definicion,
} from './helpers';

const APP = 'MiApp';
const REPO = REPOSITORIO_PARAMETROS;

/** Crea el servicio con fakes y precarga opcional de la persistencia. */
function crear(opts: { consumo?: any; dispositivo?: any; vars?: Record<string, any> } = {}) {
  const fake = new FakePersistencia();
  const dispositivo = opts.dispositivo ?? fakeDispositivo();
  const consumo = opts.consumo ?? fakeConsumo();
  const svc = new ParametrosService(fakeConfig(opts.vars), fake as any, dispositivo, consumo);
  return { svc, fake, dispositivo, consumo };
}

describe('GetParametro — resolución de alcance y contexto', () => {
  test('Neg: lee de contextId(App, EmpKey, alcanceId)', async () => {
    const { svc, fake } = crear();
    await fake.set(REPO, tagDefinicion('AgenteDefault'), definicion('AgenteDefault', { TipoDefinicionId: 'Neg' }));
    await fake.set(REPO, contextId(APP, 123, 'ALC'), [valor('AgenteDefault', '13')]);

    const v = await svc.GetParametro('AgenteDefault', { aplicacionId: APP, empKey: 123, alcanceId: 'ALC' });
    expect(v).toBe('13');
  });

  test('Disp: usa el id del dispositivo como alcance (ignora ctx.alcanceId)', async () => {
    const { svc, fake } = crear({ dispositivo: fakeDispositivo({ id: 'DEV1' }) });
    await fake.set(REPO, tagDefinicion('DIRSEND'), definicion('DIRSEND', { TipoDefinicionId: 'Disp' }));
    await fake.set(REPO, contextId(APP, 123, 'DEV1'), [valor('DIRSEND', 'X')]);

    const v = await svc.GetParametro('DIRSEND', { aplicacionId: APP, empKey: 123, alcanceId: 'IGNORADO' });
    expect(v).toBe('X');
  });

  test('jerarquía: distinto EmpKey → distinta clave y valor', async () => {
    const { svc, fake } = crear({ dispositivo: fakeDispositivo({ id: 'DEV1' }) });
    await fake.set(REPO, tagDefinicion('DIRSEND'), definicion('DIRSEND', { TipoDefinicionId: 'Disp' }));
    await fake.set(REPO, contextId(APP, 0, 'DEV1'), [valor('DIRSEND', 'APLICACION')]);
    await fake.set(REPO, contextId(APP, 9101, 'DEV1'), [valor('DIRSEND', 'PERFIL')]);

    expect(await svc.GetParametro('DIRSEND', { aplicacionId: APP, empKey: 0 })).toBe('APLICACION');
    expect(await svc.GetParametro('DIRSEND', { aplicacionId: APP, empKey: 9101 })).toBe('PERFIL');
  });

  test('definición inexistente → ""', async () => {
    const { svc } = crear();
    expect(await svc.GetParametro('NoExiste', { aplicacionId: APP, empKey: 1 })).toBe('');
  });
});

describe('GetParametroResultado — contrato discriminado', () => {
  test('configured: devuelve un valor vigente y decodificado', async () => {
    const { svc, fake } = crear();
    await fake.set(REPO, tagDefinicion('MaximoGuias'), definicion('MaximoGuias'));
    await fake.set(REPO, contextId(APP, 977, 'ALC'), [valor('MaximoGuias', '40')]);

    const resultado = await svc.GetParametroResultado(
      'MaximoGuias',
      { aplicacionId: APP, empKey: 977, alcanceId: 'ALC' },
      {
        decodificar: (raw) => {
          const numero = Number(raw);
          return Number.isInteger(numero) && numero > 0
            ? { valido: true as const, valor: numero }
            : { valido: false as const };
        },
      },
    );

    expect(resultado).toEqual({ estado: 'configured', valor: 40 });
  });

  test('not-configured: la fuente respondió y no configuró el parámetro', async () => {
    const consumo = fakeConsumo({
      definiciones: [definicion('MaximoGuias')],
      valores: [],
    });
    const { svc } = crear({ consumo });

    expect(await svc.InicializaParametrosNegocio(APP, 977, 'ALC', 'WebApp')).toBe(true);
    expect(
      await svc.GetParametroResultado('MaximoGuias', {
        aplicacionId: APP,
        empKey: 977,
        alcanceId: 'ALC',
      }),
    ).toEqual({ estado: 'not-configured' });
  });

  test('invalid-value: el decoder rechaza el valor sin exponerlo', async () => {
    const { svc, fake } = crear();
    await fake.set(REPO, tagDefinicion('MaximoGuias'), definicion('MaximoGuias'));
    await fake.set(REPO, contextId(APP, 977, 'ALC'), [valor('MaximoGuias', 'abc')]);

    const resultado = await svc.GetParametroResultado(
      'MaximoGuias',
      { aplicacionId: APP, empKey: 977, alcanceId: 'ALC' },
      { decodificar: () => ({ valido: false }) },
    );

    expect(resultado).toEqual({ estado: 'invalid-value' });
  });

  test('last-known-valid: conserva el valor validado cuando el refresco queda offline', async () => {
    const consumo = fakeConsumo({
      definiciones: [definicion('MaximoGuias')],
      valores: [valor('MaximoGuias', '55')],
    });
    const { svc } = crear({ consumo });
    const ctx = { aplicacionId: APP, empKey: 977, alcanceId: 'ALC' };

    expect(await svc.InicializaParametrosNegocio(APP, 977, 'ALC', 'WebApp')).toBe(true);
    consumo.getParametrosValues.mockRejectedValueOnce(
      Object.assign(new Error('conn refused'), { request: {}, code: 'ECONNREFUSED' }),
    );
    expect(await svc.InicializaParametrosNegocio(APP, 977, 'ALC', 'WebApp')).toBe(false);

    expect(await svc.GetParametroResultado('MaximoGuias', ctx)).toEqual({
      estado: 'last-known-valid',
      valor: '55',
      causa: 'source-unavailable',
    });
  });

  test('source-unavailable: no inventa ausencia cuando falla la fuente sin caché', async () => {
    const consumo = fakeConsumo({ definiciones: [definicion('MaximoGuias')] });
    consumo.getParametrosValues.mockRejectedValueOnce(
      Object.assign(new Error('conn refused'), { request: {}, code: 'ECONNREFUSED' }),
    );
    const { svc } = crear({ consumo });

    expect(await svc.InicializaParametrosNegocio(APP, 977, 'ALC', 'WebApp')).toBe(false);
    expect(
      await svc.GetParametroResultado('MaximoGuias', {
        aplicacionId: APP,
        empKey: 977,
        alcanceId: 'ALC',
      }),
    ).toEqual({ estado: 'source-unavailable' });
  });

  test('GetParametro conserva la compatibilidad string/""', async () => {
    const { svc, fake } = crear();
    await fake.set(REPO, tagDefinicion('P'), definicion('P'));
    await fake.set(REPO, contextId(APP, 1, 'A'), [valor('P', '42')]);

    expect(await svc.GetParametro('P', { aplicacionId: APP, empKey: 1, alcanceId: 'A' })).toBe('42');
    expect(await svc.GetParametro('NoExiste', { aplicacionId: APP, empKey: 1, alcanceId: 'A' })).toBe('');
  });
});

describe('GetParametro — ventana de vigencia', () => {
  test('valor con Fin en el pasado no es vigente → ""', async () => {
    const { svc, fake } = crear();
    await fake.set(REPO, tagDefinicion('P'), definicion('P'));
    await fake.set(REPO, contextId(APP, 1, 'A'), [
      valor('P', 'viejo', { ValorParametroIni: '2000-01-01T00:00:00', ValorParametroFin: '2001-01-01T00:00:00' }),
    ]);
    expect(await svc.GetParametro('P', { aplicacionId: APP, empKey: 1, alcanceId: 'A' })).toBe('');
  });

  test('fechas "0000-00-00" se tratan como sin límite → vigente', async () => {
    const { svc, fake } = crear();
    await fake.set(REPO, tagDefinicion('P'), definicion('P'));
    await fake.set(REPO, contextId(APP, 1, 'A'), [
      valor('P', 'siempre', { ValorParametroIni: '0000-00-00T00:00:00', ValorParametroFin: '0000-00-00T00:00:00' }),
    ]);
    expect(await svc.GetParametro('P', { aplicacionId: APP, empKey: 1, alcanceId: 'A' })).toBe('siempre');
  });
});

describe('GetParametro — valores compuestos y sufijo', () => {
  const setup = async () => {
    const ctx = crear({ dispositivo: fakeDispositivo({ id: 'DEV1' }) });
    await ctx.fake.set(
      REPO,
      tagDefinicion('PI_TipoDefault'),
      definicion('PI_TipoDefault', { TipoDefinicionId: 'Disp', Separador: '.', TipoParametroSeparadorInicioFin: true }),
    );
    await ctx.fake.set(REPO, contextId(APP, 123, 'DEV1'), [valor('PI_TipoDefault', '.CORREO.DNI.RUT.')]);
    return ctx;
  };

  test('id con "_" que ES un parámetro → devuelve el valor completo', async () => {
    const { svc } = await setup();
    expect(await svc.GetParametro('PI_TipoDefault', { aplicacionId: APP, empKey: 123 })).toBe('.CORREO.DNI.RUT.');
  });

  test('sufijo por índice (1-based) extrae el componente', async () => {
    const { svc } = await setup();
    expect(await svc.GetParametro('PI_TipoDefault_1', { aplicacionId: APP, empKey: 123 })).toBe('CORREO');
    expect(await svc.GetParametro('PI_TipoDefault_2', { aplicacionId: APP, empKey: 123 })).toBe('DNI');
    expect(await svc.GetParametro('PI_TipoDefault_3', { aplicacionId: APP, empKey: 123 })).toBe('RUT');
  });

  test('índice fuera de rango → ""', async () => {
    const { svc } = await setup();
    expect(await svc.GetParametro('PI_TipoDefault_4', { aplicacionId: APP, empKey: 123 })).toBe('');
  });

  test('sufijo por NOMBRE de componente (estructura Location) resuelve por posición', async () => {
    const { svc, fake } = crear();
    // Definición tipo Location: estructura por TipoParametroID, separador ";" al inicio/fin.
    await fake.set(
      REPO,
      tagDefinicion('MiLoc'),
      definicion('MiLoc', { TipoParametroID: 'Location', Separador: ';', TipoParametroSeparadorInicioFin: true }),
    );
    await fake.set(REPO, 'EstructuraLocation', {
      ParametroEstructuraId: 'Location',
      Componente: ['Host', 'Puerto', 'BaseURL', 'TimeOut', 'Secure', 'LocationName'].map((id) => ({
        ParametroEstructuraComponenteId: id,
      })),
    });
    await fake.set(REPO, contextId(APP, 1, 'A'), [valor('MiLoc', ';miHost;443;/base;30;1;nombre')]);

    const ctx = { aplicacionId: APP, empKey: 1, alcanceId: 'A' };
    expect(await svc.GetParametro('MiLoc_Host', ctx)).toBe('miHost');
    expect(await svc.GetParametro('MiLoc_Puerto', ctx)).toBe('443');
    expect(await svc.GetParametro('MiLoc_BaseURL', ctx)).toBe('/base');
    expect(await svc.GetParametro('MiLoc_LocationName', ctx)).toBe('nombre');
    expect(await svc.GetParametro('MiLoc_NoExiste', ctx)).toBe(''); // componente inexistente
  });
});

describe('Caché en proceso (miss)', () => {
  test('positiva: tras borrar el blob de Redis, el hit sigue respondiendo', async () => {
    const { svc, fake } = crear();
    await fake.set(REPO, tagDefinicion('P'), definicion('P'));
    const clave = contextId(APP, 1, 'A');
    await fake.set(REPO, clave, [valor('P', '42')]);

    expect(await svc.GetParametro('P', { aplicacionId: APP, empKey: 1, alcanceId: 'A' })).toBe('42');
    await fake.repositorio.eliminar(clave, REPO); // el blob desaparece de Redis
    expect(await svc.GetParametro('P', { aplicacionId: APP, empKey: 1, alcanceId: 'A' })).toBe('42'); // memo
  });

  test('negativa (NoExiste): no re-lee aunque luego aparezca la definición', async () => {
    const { svc, fake } = crear();
    expect(await svc.GetParametro('Z', { aplicacionId: APP, empKey: 1, alcanceId: 'A' })).toBe(''); // miss, cachea NoExiste
    await fake.set(REPO, tagDefinicion('Z'), definicion('Z'));
    await fake.set(REPO, contextId(APP, 1, 'A'), [valor('Z', '99')]);
    expect(await svc.GetParametro('Z', { aplicacionId: APP, empKey: 1, alcanceId: 'A' })).toBe(''); // sigue NoExiste
  });
});

describe('InicializaParametrosNegocio / Dispositivo', () => {
  const data = {
    definiciones: [definicion('DIRSEND', { TipoDefinicionId: 'Disp' })],
    estructuras: [],
    valores: [valor('DIRSEND', 'X')],
  };

  test('puebla definición + valores bajo la clave del scope y marca vigente', async () => {
    const consumo = fakeConsumo(data);
    const { svc, fake } = crear({ consumo, dispositivo: fakeDispositivo({ id: 'DEV1' }) });

    const ok = await svc.InicializaParametrosDispositivo(APP, 123, 'WebApp');
    expect(ok).toBe(true);
    expect(await fake.get(REPO, tagDefinicion('DIRSEND'))).toBeTruthy();
    expect(await fake.get(REPO, contextId(APP, 123, 'DEV1'))).toEqual(data.valores);
    // ambiente obtenido de api-dispositivos y enviado al backend
    expect(consumo.getParametrosValues).toHaveBeenCalledWith(expect.objectContaining({ ambienteId: 'QA' }));
  });

  test('vigente + sin notificación + modo "" → NO refresca', async () => {
    const consumo = fakeConsumo(data);
    const { svc } = crear({ consumo, dispositivo: fakeDispositivo({ id: 'DEV1' }) });
    await svc.InicializaParametrosDispositivo(APP, 123, 'WebApp'); // 1er refresco
    await svc.InicializaParametrosDispositivo(APP, 123, ''); // vigente → skip
    expect(consumo.getParametrosValues).toHaveBeenCalledTimes(1);
  });

  test('modo WebApp fuerza refresco aunque esté vigente', async () => {
    const consumo = fakeConsumo(data);
    const { svc } = crear({ consumo, dispositivo: fakeDispositivo({ id: 'DEV1' }) });
    await svc.InicializaParametrosDispositivo(APP, 123, 'WebApp');
    await svc.InicializaParametrosDispositivo(APP, 123, 'WebApp');
    expect(consumo.getParametrosValues).toHaveBeenCalledTimes(2);
  });
});

describe('Invalidación por notificación push', () => {
  const data = { definiciones: [definicion('DIRSEND', { TipoDefinicionId: 'Disp' })], valores: [valor('DIRSEND', 'X')] };

  test('notificarRefresco fuerza el siguiente Inicializa vigente; luego se consume', async () => {
    const consumo = fakeConsumo(data);
    const { svc } = crear({ consumo, dispositivo: fakeDispositivo({ id: 'DEV1' }) });

    await svc.InicializaParametrosDispositivo(APP, 123, 'WebApp'); // #1
    await svc.InicializaParametrosDispositivo(APP, 123, ''); // vigente → skip (sigue 1)
    expect(consumo.getParametrosValues).toHaveBeenCalledTimes(1);

    await svc.notificarRefresco(APP, 123, 'DEV1');
    await svc.InicializaParametrosDispositivo(APP, 123, ''); // notificación → refresca (#2)
    expect(consumo.getParametrosValues).toHaveBeenCalledTimes(2);

    await svc.InicializaParametrosDispositivo(APP, 123, ''); // ya consumida → skip (sigue 2)
    expect(consumo.getParametrosValues).toHaveBeenCalledTimes(2);
  });
});

describe('Circuit-breaker offline', () => {
  const errRed = Object.assign(new Error('conn refused'), { request: {}, code: 'ECONNREFUSED' });
  const errHttp = Object.assign(new Error('server error'), { response: { status: 500 } });

  test('error de RED abre el circuito; el siguiente Inicializa omite la llamada', async () => {
    const consumo = fakeConsumo({ definiciones: [], estructuras: [] });
    consumo.getParametrosValues.mockRejectedValue(errRed);
    const { svc, fake } = crear({ consumo, dispositivo: fakeDispositivo({ id: 'DEV1' }) });

    expect(await svc.InicializaParametrosDispositivo(APP, 123, 'WebApp')).toBe(false); // falla, abre circuito
    expect(await fake.repositorio.existe('Offline_Valores_MiApp', REPO)).toBe(true);

    expect(await svc.InicializaParametrosDispositivo(APP, 123, 'WebApp')).toBe(true); // usa caché, no llama
    expect(consumo.getParametrosValues).toHaveBeenCalledTimes(1);
  });

  test('error HTTP (con response) NO abre el circuito', async () => {
    const consumo = fakeConsumo({ definiciones: [], estructuras: [] });
    consumo.getParametrosValues.mockRejectedValue(errHttp);
    const { svc, fake } = crear({ consumo, dispositivo: fakeDispositivo({ id: 'DEV1' }) });

    await svc.InicializaParametrosDispositivo(APP, 123, 'WebApp');
    expect(await fake.repositorio.existe('Offline_Valores_MiApp', REPO)).toBe(false);

    await svc.InicializaParametrosDispositivo(APP, 123, 'WebApp'); // reintenta (no hay breaker)
    expect(consumo.getParametrosValues).toHaveBeenCalledTimes(2);
  });
});
