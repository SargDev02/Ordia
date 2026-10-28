# Servicios

`supabase.ts` contiene la única instancia del cliente de Supabase para el navegador.

- Solo admite la URL y la clave publicable configuradas mediante variables `VITE_`.
- La URL remota debe corresponder al proyecto Ordia; también se admite Supabase local para pruebas.
- Rechaza claves `sb_secret_` y JWT con rol `service_role`.
- El SDK administra la persistencia y renovación de la sesión.
- `finance.ts` concentra las operaciones sobre cuentas y movimientos. Las escrituras críticas se validan y serializan en PostgreSQL.
- `FinanceContext` administra las suscripciones Realtime, su limpieza y la recarga completa al conectar.

- `tasks.ts` concentra las operaciones de tareas privadas. `TasksProvider` administra Realtime y descarta datos/respuestas al cambiar de sesión.
- `pushNotifications.ts` registra o desactiva el navegador actual para recordatorios de pagos.

- `calendar.ts` consulta únicamente la copia privada de eventos en Supabase e invoca la Edge Function autenticada. El navegador nunca contacta CalDAV ni puede recuperar la contraseña guardada. El acceso a Apple, el cifrado y la sincronización viven en `supabase/functions/_shared/icloud`.

- `googleCalendar.ts` consulta la copia Google del usuario e invoca `google-calendar`. Solo recibe un ticket de autorización efímero para navegar al servidor; nunca tokens Google. OAuth, renovación, cifrado, paginación y revocación viven en `supabase/functions/_shared/google`.
- `useCalendarProvider` comparte recuperación, limpieza de sesión y Realtime entre los dos proveedores. `useCalendarAgenda` combina sus selecciones con identificadores separados y errores independientes.

iCloud y Google son de lectura. No hay Notion, escritura en calendarios ni recordatorios de tareas. El usuario confirmó conexión y consulta real de ambos proveedores, tras habilitar Google Calendar API. La función Google identifica errores por fase y UUID sin registrar códigos, tokens ni secretos. El retorno OAuth admite el dominio publicado de Ordia y los dos orígenes locales documentados; la autorización desde producción y el iPhone se verifican por separado.
