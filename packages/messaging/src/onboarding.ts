import {randomUUID} from 'node:crypto';
import {ProviderError} from './types.js';

const problems = {
  CHANNEL_ACCOUNT_DELETED: [410, 'Este número fue eliminado.', 'Su historial se conserva. Agrega un número nuevo para volver a operar.', false, false],
  QR_NOT_SUPPORTED: [409, 'Este transporte utiliza la incorporación oficial de Meta.', 'Abre la integración de Meta para revisar sus requisitos.', false, false],
  SIMULATION_HAS_NO_REAL_QR: [409, 'Las cuentas simuladas no generan un QR real.', 'Cambia al entorno Real y selecciona una cuenta WAHA.', false, false],
  QR_OPERATION_NOT_AUTHORIZED: [403, 'La preparación de sesiones está deshabilitada para este entorno.', 'En Sistema → Operación, cambia Vinculación de números a Permitir conexión y QR. Puedes mantener los envíos congelados.', false, false],
  CHANNEL_QR_UNAVAILABLE: [503, 'El servicio interno de QR no está configurado.', 'Revisa la URL privada y la credencial entre API y channel-worker.', false, true],
  PROVIDER_CONFIGURATION_REQUIRED: [503, 'Falta configuración del gateway para esta cuenta.', 'Configura su conexión y credenciales en Configuración → Integraciones.', false, true],
  GATEWAY_AUTH_REJECTED: [502, 'El gateway rechazó la autenticación del servidor.', 'Revisa las credenciales y los permisos del gateway.', false, true],
  CHANNEL_AUTH_REJECTED: [502, 'El servicio interno rechazó la autenticación de la API.', 'Revisa la credencial compartida entre API y channel-worker.', false, true],
  SESSION_NOT_FOUND: [409, 'La sesión todavía no existe en el gateway.', 'Pulsa Conectar y espera a que termine antes de solicitar el QR.', true, false],
  QR_NOT_READY: [409, 'El QR todavía no está listo o ya venció.', 'Espera unos segundos y vuelve a solicitarlo. Revisa el estado de la sesión.', true, false],
  SESSION_ALREADY_CONNECTED: [409, 'La sesión ya está conectada.', 'Actualiza su estado y verifica la identidad conectada.', false, false],
  SESSION_CONFLICT: [409, 'El gateway informó un conflicto de sesión.', 'Revisa la sesión existente antes de volver a conectar; no reinicies otras cuentas.', false, true],
  CHANNEL_GATEWAY_ALREADY_ASSIGNED: [409, 'Este gateway y sesión están asignados a más de una cuenta.', 'Asigna un gateway exclusivo a cada cuenta antes de conectar.', false, true],
  OWNERSHIP_GENERATION_CHANGED: [409, 'Cambió el proceso que controla la sesión.', 'Actualiza el estado. El resultado tardío quedó registrado sin modificar la sesión actual.', false, true],
  OWNERSHIP_REQUIRED: [409, 'Este proceso no tiene el control exclusivo de la sesión.', 'Revisa quién controla la cuenta antes de reanudar.', false, true],
  OLD_OWNER_ISOLATION_AND_RECONCILIATION_REQUIRED: [409, 'El dueño anterior de la sesión todavía requiere revisión.', 'Conserva el congelamiento y verifica aislamiento y operaciones pendientes antes de transferir.', false, true],
  FREEZE_MUST_PRECEDE_TRANSFER: [409, 'La cuenta debe congelarse antes de transferir su control.', 'Congela la cuenta y revisa sus operaciones pendientes.', false, false],
  VERIFIED_ISOLATION_PROOF_REQUIRED: [409, 'Falta evidencia válida de aislamiento del dueño anterior.', 'Solicita una verificación técnica antes de transferir la sesión.', false, true],
  REAL_LIFECYCLE_AUTHORIZATION_REQUIRED: [403, 'Reanudar la salida real requiere autorización independiente.', 'Mantén los envíos congelados hasta autorizar una operación concreta.', false, true],
  CHANNEL_TIMEOUT: [504, 'El servicio de QR no respondió a tiempo.', 'Consulta el estado antes de repetir una conexión. Puedes volver a solicitar el QR.', true, false],
  QR_RESPONSE_INVALID: [502, 'El gateway devolvió un QR que no se pudo validar.', 'Revisa la compatibilidad y versión del adaptador.', false, true],
  CHANNEL_OPERATION_FAILED: [502, 'No se pudo completar la operación del canal.', 'Revisa la referencia de diagnóstico y el estado de la cuenta.', false, true],
  ACCOUNT_NOT_FOUND: [404, 'La cuenta no está disponible en este entorno.', 'Actualiza la lista y selecciona una cuenta del entorno actual.', false, false],
  NOT_FOUND: [404, 'La cuenta no está disponible en este entorno.', 'Actualiza la lista y selecciona una cuenta del entorno actual.', false, false],
} as const;
export type OnboardingCode = keyof typeof problems;
export const onboardingEnabled = (settings:{allow_channel_onboarding:boolean}) => settings.allow_channel_onboarding===true;
export function onboardingCode(error:unknown, operation:string):OnboardingCode {
  const code = error instanceof ProviderError ? error.code : error instanceof Error ? error.message : '';
  if (code in problems) return code as OnboardingCode;
  if (code.startsWith('PROVIDER_CONFIGURATION_REQUIRED_') || /GATEWAY_URL_INVALID|PROVIDER_UNSUPPORTED/.test(code)) return 'PROVIDER_CONFIGURATION_REQUIRED';
  const status = error instanceof ProviderError ? error.httpStatus : undefined;
  if (status === 401 || status === 403) return 'GATEWAY_AUTH_REJECTED';
  if (status === 404) return 'SESSION_NOT_FOUND';
  if (status === 409 || status === 422) return operation === 'get_qr' ? 'QR_NOT_READY' : 'SESSION_CONFLICT';
  if (status === 429 || status === 408 || error instanceof Error && ['TimeoutError','AbortError'].includes(error.name)) return 'CHANNEL_TIMEOUT';
  return 'CHANNEL_OPERATION_FAILED';
}
export function onboardingFailure(code:OnboardingCode,operation:string,accountStatus:unknown,diagnosticId:string=randomUUID(),attemptedAt=new Date().toISOString()) {
  const [statusCode,message,action,retryable,technical_intervention] = problems[code];
  const account_status = typeof accountStatus === 'string' && /^(NEW|UNKNOWN|STOPPED|STARTING|SCAN_QR_CODE|WORKING|FAILED|CONNECTED|DISCONNECTED|PAUSED|PASSKEY_REQUIRED|PASSKEY_CONFIRMATION_REQUIRED)$/.test(accountStatus) ? accountStatus : 'UNKNOWN';
  return {statusCode,error:{code,message,diagnostic:{diagnostic_id:diagnosticId,attempted_at:attemptedAt,operation,code,retryable,action,technical_intervention,account_status}}};
}
