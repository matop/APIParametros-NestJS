/** Estados observables de una lectura de parámetro. */
export type EstadoParametro =
  | 'configured'
  | 'last-known-valid'
  | 'not-configured'
  | 'invalid-value'
  | 'source-unavailable';

/** Resultado de un decodificador provisto por el caller. */
export type ResultadoDecodificacion<T> =
  | Readonly<{ valido: true; valor: T }>
  | Readonly<{ valido: false }>;

/**
 * Convierte y valida el string persistido sin trasladar reglas de dominio al
 * paquete. El caller decide, por ejemplo, qué representa un entero positivo.
 */
export type DecodificadorParametro<T> = (valor: string) => ResultadoDecodificacion<T>;

export type OpcionesResultadoParametro<T> = Readonly<{
  decodificar: DecodificadorParametro<T>;
}>;

/**
 * Contrato discriminado de lectura. No expone Redis, excepciones internas ni
 * el valor rechazado por un decodificador.
 */
export type ResultadoParametro<T = string> =
  | Readonly<{ estado: 'configured'; valor: T }>
  | Readonly<{
      estado: 'last-known-valid';
      valor: T;
      causa: 'source-unavailable';
    }>
  | Readonly<{ estado: 'not-configured' }>
  | Readonly<{ estado: 'invalid-value' }>
  | Readonly<{ estado: 'source-unavailable' }>;
