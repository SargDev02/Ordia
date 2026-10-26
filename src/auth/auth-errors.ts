export function getAuthErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : ''

  if (message.includes('invalid login credentials')) {
    return 'El correo o la contraseña no son correctos.'
  }
  if (message.includes('email not confirmed')) {
    return 'Confirma tu correo antes de iniciar sesión.'
  }
  if (message.includes('user already registered')) {
    return 'Ya existe una cuenta con este correo.'
  }
  if (message.includes('password should be') || message.includes('weak password')) {
    return 'La contraseña no cumple los requisitos de seguridad.'
  }
  if (message.includes('rate limit') || message.includes('too many requests')) {
    return 'Se realizaron demasiados intentos. Espera unos minutos y vuelve a intentarlo.'
  }
  if (message.includes('network') || message.includes('fetch')) {
    return 'No fue posible conectar con el servicio. Revisa tu conexión e inténtalo de nuevo.'
  }
  if (message.includes('same password')) {
    return 'La nueva contraseña debe ser diferente de la actual.'
  }

  return 'No pudimos completar la solicitud. Inténtalo de nuevo.'
}
