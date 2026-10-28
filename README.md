# Ordia

**Tu tiempo y tu dinero, en orden.**

Aplicación web personal y adaptable para organizar tiempo y finanzas. Incluye finanzas, gastos fijos, infraestructura Web Push, tareas con checklist y una agenda privada de iCloud y Google Calendar en modo de lectura. URL de prueba HTTPS: **https://ordia-seven.vercel.app**. El usuario confirmó el funcionamiento de tareas/checklist y la conexión y consulta real de ambos proveedores antes de esta publicación. La autorización iniciada desde el dominio publicado y la prueba en iPhone se comprueban por separado; no se dan por realizadas por las pruebas locales.

## Tecnologías

- React 19, TypeScript y Vite
- pnpm y Tailwind CSS 4
- React Router
- Supabase Auth, Database y Realtime con `@supabase/supabase-js`
- Service Worker, Push API y Notifications API
- Supabase Edge Functions, Vault y Cron para el procesamiento en servidor
- Supabase CLI y migraciones SQL versionadas
- Vitest, Testing Library y pgTAP
- Manifest y service worker para instalar Ordia como PWA

## Requisitos

- Node.js 22 o superior
- pnpm 11 o superior
- Docker Desktop para ejecutar Supabase y pgTAP localmente
- Acceso al proyecto Supabase **Ordia** con ref `dedtyhomynsmvatfnshs`

## Instalación y ejecución

```powershell
pnpm install
Copy-Item .env.example .env.local
```

Configura `.env.local` solo con los valores públicos de Ordia:

```dotenv
VITE_SUPABASE_URL=https://dedtyhomynsmvatfnshs.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
VITE_VAPID_PUBLIC_KEY=clave_publica_vapid
```

La clave publicable se obtiene en **Supabase Dashboard → Project Settings → API Keys** o en el diálogo **Connect**. La clave pública VAPID es segura para el navegador. Nunca uses una clave `sb_secret_`, `service_role`, la clave privada VAPID ni el secreto del cron en una variable `VITE_`.

Inicia la aplicación:

```powershell
pnpm dev
```

Abre `http://localhost:5173`. Vite usa el puerto fijo `5173` para que los enlaces de autenticación no cambien de destino.

## Configuración de Supabase Auth

En el proyecto Ordia (`dedtyhomynsmvatfnshs`):

1. En **Authentication → Providers → Email**, habilita correo y contraseña y conserva activa la confirmación de correo.
2. En **Authentication → URL Configuration**, la **Site URL** remota de prueba es `https://ordia-seven.vercel.app`; el entorno Supabase local conserva `http://localhost:5173`.
3. Agrega estas **Redirect URLs**:

   ```text
   http://localhost:5173/auth/confirm
   http://localhost:5173/restablecer-contrasena
   https://ordia-seven.vercel.app/auth/confirm
   https://ordia-seven.vercel.app/restablecer-contrasena
   ```

## Modelo financiero

El modelo se construye con estas migraciones versionadas:

- `supabase/migrations/20261026173736_create_financial_accounts_and_transactions.sql`
- `supabase/migrations/20261026220000_add_financial_categories.sql`
- `supabase/migrations/20261026230000_add_recurring_fixed_expenses.sql`
- `supabase/migrations/20261026234754_fix_fixed_expense_function_lint.sql`
- `supabase/migrations/20261027001830_add_push_notifications.sql`
- `supabase/migrations/20261027002318_harden_push_subscription_rpcs.sql`

- `financial_accounts` conserva nombre, tipo, COP, saldo inicial y fecha de archivo.
- `financial_transactions` representa un ingreso, gasto o transferencia completa. Una transferencia usa una sola fila con origen y destino; por ello se crea, edita o elimina atómicamente y no entra en los totales de ingresos o gastos.
- Los importes se guardan como `bigint` en pesos COP enteros. El límite actual está por debajo del máximo entero seguro de JavaScript, evitando aritmética binaria con decimales.
- El saldo se deriva siempre de saldo inicial más movimientos vigentes; no existe una columna de saldo mutable que pueda quedar desincronizada.
- `client_request_id` es único por usuario y la función de creación es idempotente, lo que evita duplicados ante doble envío o reintentos.
- La eliminación es lógica (`deleted_at`). Esto conserva auditoría y permite que Realtime comunique el cambio como `UPDATE` sujeto a RLS; los eventos `DELETE` de Postgres Changes no pueden filtrarse por RLS de la misma forma.
- Las restricciones, triggers y RLS validan propiedad, moneda, cuentas activas y forma de cada movimiento además de las validaciones del formulario.
- Las cuentas se bloquean en orden durante una escritura financiera para serializar el archivado y los movimientos concurrentes.
- `financial_categories` contiene categorías privadas por usuario para ingresos o gastos. Admite una categoría principal y una subcategoría, con nombres únicos por tipo y nivel sin distinguir mayúsculas ni espacios exteriores.
- Los movimientos guardan `category_id`, no una copia del nombre. Por eso renombrar una categoría actualiza su presentación sin perder asociaciones históricas.
- Archivar una categoría principal archiva también sus subcategorías. Las categorías archivadas no están disponibles para movimientos nuevos, pero conservan el historial y permiten editar otros campos de movimientos existentes.

Cada usuario recibe categorías iniciales editables. La aplicación muestra una subcategoría como `Categoría > Subcategoría` y agrupa los gastos de sus subcategorías una sola vez bajo la categoría principal. Usa `America/Bogota` para los límites mensuales predeterminados.

### Selección de cuentas y alcance de los filtros

- El selector permite consultar todas, una, varias o ninguna cuenta, incluidas cuentas archivadas para acceder a su historial.
- **Todas** mantiene seleccionadas todas las cuentas disponibles, incluso si Realtime incorpora una nueva. **Limpiar** representa realmente ninguna selección: saldos, totales y movimientos quedan en cero o vacíos, sin sustituir silenciosamente por todas.
- **Saldo total** suma el saldo actual de las cuentas seleccionadas. No se limita por fecha o tipo porque representa el saldo vigente.
- **Ingresos y gastos del período** respetan las cuentas, fechas y tipo seleccionados. Sin fechas personalizadas se usa el mes actual en `America/Bogota`.
- La lista de movimientos combina selección de cuentas, tipo y límites de fecha. Los estados vacíos distinguen entre ningún resultado y ninguna cuenta seleccionada.
- Una transferencia se guarda en una sola fila y aparece una sola vez cuando está seleccionado su origen, su destino o ambos. Afecta los saldos de ambas cuentas, pero nunca los totales de ingresos, gastos ni la agrupación por categoría.

## Gastos fijos y pagos recurrentes

La navegación financiera separa **Resumen** y **Gastos fijos** para no alargar la página principal. El inicio resume por separado las obligaciones impagas cuyo vencimiento cae en el mes actual y todas las deudas anteriores a hoy. Una obligación pendiente es informativa y no descuenta el saldo ni se suma a gastos realizados.

El modelo separa tres responsabilidades:

- `fixed_expenses` identifica la recurrencia, sus notas y su estado activo, pausado o dado de baja.
- `fixed_expense_versions` conserva configuraciones efectivas desde una fecha: importe previsto en COP, categoría, cuenta sugerida, frecuencia y fecha base. Editar crea una versión futura en vez de reescribir pagos o vencimientos anteriores.
- `fixed_expense_periods` guarda cada obligación concreta y la instantánea de sus datos previstos. La combinación gasto fijo + vencimiento es única y el generador usa `UPSERT`, por lo que reintentos y dos dispositivos no crean períodos duplicados.

Se generan todos los períodos omitidos desde el inicio de la recurrencia y solo tres meses hacia adelante desde hoy. Ese horizonte se renueva al cargar o reconectar. Las fechas se evalúan en `America/Bogota`: un pendiente anterior a hoy está vencido. Las recurrencias conservan el día original; el 31 usa el último día de un mes corto y vuelve al 31 después, y el 29 de febrero usa el 28 en años no bisiestos sin desplazar años futuros.

La vista principal **Pendientes del mes** muestra una sola fila por gasto fijo. Incluye obligaciones impagas con vencimiento en el mes actual y conserva visibles las de meses anteriores: cuando hay deuda acumulada presenta la más antigua e indica cuántos pagos adicionales siguen pendientes. Al pagar una obligación de este mes se retira la fila y no se promueve automáticamente un período posterior; una deuda anterior sí deja visible la siguiente deuda vencida o del mes actual que corresponda. El detalle conserva todos los períodos futuros para consulta y pago anticipado, además del historial pagado y los períodos cancelados.

Las tarjetas y pestañas usan estos criterios en `America/Bogota`:

- **Pendientes del mes** suma únicamente obligaciones impagas cuyo vencimiento está entre el primer y último día del mes actual.
- **Vencidos** suma todas las obligaciones impagas con vencimiento anterior a hoy, también las del mes actual. Por eso una obligación vencida dentro del mes pertenece legítimamente a ambos totales.
- **Pagados este mes** usa el importe real y la fecha real de pago (`paid_on`), no el vencimiento. Un período de este mes pagado anticipadamente permanece pagado en el detalle, pero no se contabiliza otra vez como pago del mes actual.
- **Próximo mes** está acotado al mes calendario inmediatamente siguiente y se identifica expresamente como distinto de los pendientes actuales. Los demás períodos futuros siguen disponibles en **Ver detalle**.

Estos criterios se mantienen para gastos pausados o dados de baja: sus obligaciones no canceladas y deudas históricas siguen en las listas y sumas correspondientes. Consultar períodos o cambiar de pestaña nunca crea un movimiento ni modifica un saldo.

- **Pausar** conserva pagos y obligaciones ya vencidas, cancela lo próximo y no genera cobros durante la pausa.
- **Reactivar** exige el siguiente vencimiento; el intervalo pausado no se recupera como deuda.
- **Dar de baja** cancela obligaciones desde hoy, conserva pendientes ya vencidos y mantiene todo el historial.
- Cambios de importe, categoría, cuenta o calendario piden una fecha efectiva. Solo sustituyen obligaciones futuras pendientes desde allí.

Pagar una obligación crea un gasto financiero normal y vincula ambas filas en una sola RPC transaccional. El importe y la fecha reales pueden diferir de lo previsto. `payment_request_id`, el bloqueo del período y las restricciones únicas evitan pagos duplicados. Ese gasto aparece una sola vez en movimientos, saldos, filtros y reportes; desde la lista general se identifica como **Gasto fijo** y se dirige al flujo especializado. **Deshacer pago** elimina lógicamente el movimiento y devuelve la obligación a pendiente en la misma operación. No hay pagos parciales en esta etapa.

## Tareas y checklist personal

La navegación **Resumen / Gastos fijos / Tareas / Calendario** permite abrir `/tareas` directamente después de iniciar sesión. Los formularios de creación y edición reutilizan el diálogo adaptable con foco inicial, cierre por Escape, retorno de foco y confirmación para descartar cambios. El título es obligatorio (máximo 200 caracteres); descripción (hasta 5.000), duración entera positiva en minutos, vencimiento y programación son opcionales. La prioridad predeterminada es media, con opciones baja y alta.

- **Vencimiento** es una fecha límite sin hora (`date`). Una tarea que vence hoy permanece a tiempo hasta terminar el día en America/Bogota.
- **Programación** es el instante previsto para trabajar (`timestamptz`). El formulario y la presentación usan expresamente Bogotá, aunque el dispositivo tenga otra zona horaria. Una programación pasada no convierte por sí sola una tarea en vencida.
- **Pendientes** contiene todas las tareas sin completar, también sin fechas. **Programadas** contiene pendientes con programación, pasada o futura. **Vencidas** usa únicamente vencimiento anterior a hoy. **Completadas** muestra el historial ordenado por finalización.
- La búsqueda por título y el filtro por prioridad se combinan con la vista. Las listas se presentan en páginas de 20 tareas para contener la longitud.
- Marcar una tarea registra la hora de finalización en PostgreSQL. Repetir la misma marca conserva esa hora. Desmarcarla la devuelve a pendiente y limpia su finalización actual; no se guarda una bitácora de cada alternancia.
- La eliminación pide confirmación y conserva el registro con `deleted_at`. No hay borrado físico ni restauración de tareas eliminadas desde la interfaz.
- El inicio muestra como máximo cinco pendientes que estén programadas para hoy, venzan hoy o ya estén vencidas. Cada tarea aparece una sola vez aunque cumpla varias condiciones; el contador y el enlace permiten consultar el resto. Se pueden completar directamente y crear nuevas tareas sin perder las acciones financieras.
- La fecha de las vistas se actualiza al llegar la medianoche de Bogotá y al regresar a la pestaña. Los filtros no alteran saldos, pagos ni sus recordatorios.

### Sugerencias deterministas de horarios para tareas

Ordia incorpora un motor determinista de reglas para proponer horarios de trabajo a tareas pendientes, sin servicios externos ni modelos de IA:

1. **Disponibilidad personal por usuario**:
   - Configuración persistente en la tabla `task_scheduling_preferences`, sincronizada mediante Realtime y aislada con RLS.
   - Permite definir días de la semana (Lunes a Domingo) y múltiples franjas horarias por día (ej. mañana y tarde), validando que no se superpongan entre sí.
   - Margen entre compromisos (`buffer_minutes`, predeterminado 15 minutos).
   - Opción explícita para decidir si los eventos de todo el día bloquean la jornada completa (`all_day_blocks`, predeterminado activado).
   - La zona horaria se muestra y opera siempre en `America/Bogota (UTC−5)`. Si no hay disponibilidad configurada, la aplicación solicita definirla antes de generar sugerencias.

2. **Cálculo determinista de espacios libres**:
   - Explora una ventana de 7 días continuos a partir del día actual en Bogotá.
   - Excluye estrictamente horas pasadas (`now + buffer`), eventos ocupados de calendarios seleccionados (iCloud y Google) y tareas pendientes ya programadas.
   - Fusiona intervalos ocupados superpuestos o contiguos de cualquier proveedor antes de calcular huecos.
   - Los eventos de la copia sincronizada se tratan de forma conservadora como ocupados. Esta etapa no añade una clasificación propia de `free`/`busy` ni de invitaciones rechazadas.
   - Regla conservadora: ante eventos con horario sin estado explícito se asume ocupado; para tareas programadas sin duración estimada, se reserva un bloque preventivo de 30 minutos más margen y se advierte en la interfaz.

3. **Cobertura de datos de calendario**:
   - Comprueba que el rango de 7 días esté cubierto por la sincronización de los calendarios externos seleccionados.
   - Si una sincronización tiene más de 24 horas o falló, se informa y se evita dar por libres esos horarios sin alertar al usuario.
   - Si no hay calendarios conectados o seleccionados, permite sugerencias basadas únicamente en la disponibilidad y tareas de Ordia, informando de esta limitación.
   - Muestra la fecha/hora de la última sincronización y permite actualizar antes de generar sugerencias.

4. **Sugerencias y planificación**:
   - Sección compacta «Tareas por organizar» que prioriza por vencimiento próximo (`due_on`) y luego por prioridad (alta > media > baja) con desempate estable por título e ID.
   - «Sugerir horario» requiere una duración estimada en minutos (editable en la misma fila si no se especificó antes).
   - Genera hasta 3 alternativas ordenadas por cercanía en el tiempo. Cada alternativa cabe completa en un único bloque continuo.
   - Respeta la fecha límite: no sugiere horarios posteriores al final del día de vencimiento. Si la tarea ya venció, indica el atraso y ofrece los próximos espacios como reprogramación tardía.
   - Las alternativas son propuestas independientes. Al programar una, las restantes se recalculan inmediatamente.

5. **Aceptación y seguridad concurrente frente a conflictos**:
   - **Diagnóstico y protección multicanal**: El bloqueo de fila `SELECT ... FOR UPDATE` sobre la fila de la tarea protege frente a modificaciones concurrentes sobre la misma tarea, pero resultaba insuficiente para serializar dos tareas distintas del mismo usuario intentando programarse en el mismo horario.
   - **Migración `20261028130644_serialize_task_scheduling_conflicts.sql`**:
     - Serializa la comprobación y escritura por usuario en PostgreSQL utilizando un bloqueo consultivo transaccional: `pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('ordia.task_schedule:' || user_id::text, 0))`.
     - Trigger `validate_personal_task_schedule` ejecutado en `BEFORE INSERT OR UPDATE ON public.personal_tasks`: adquiere el candado consultivo y comprueba que ninguna otra tarea pendiente del usuario solape el intervalo futuro `[scheduled_at, scheduled_at + duración)`, usando 30 minutos si falta duración. Protege contra solapamientos estrictos también en edición manual (`TaskEditor`, `saveTask`, `INSERT` o `UPDATE` directos), con SQLSTATE `23P01 (task_schedule_overlap)`. Las comprobaciones adicionales de disponibilidad, margen, vencimiento y caché externa pertenecen a la RPC de aceptación de sugerencias.
     - La RPC `schedule_personal_task` revalida exhaustivamente:
       1. Estado, versión (`updated_at`) y duración positiva (`estimated_minutes > 0`).
       2. Que `scheduled_at` no sea anterior a `now()` (inicio de la transacción).
       3. Que el intervalo quepa dentro de las franjas horarias configuradas por el usuario (`outside_availability`).
       4. Que respete los márgenes configurados (`buffer_minutes`) respecto a otras tareas programadas y eventos de calendario.
       5. Si `due_on` es hoy o posterior en America/Bogota, debe terminar antes de acabar ese día (`after_due_date`). Si el vencimiento ya pasó, permite una reprogramación tardía futura sin cambiar `due_on`; el frontend muestra «Venció» y «Reprogramación tardía» con la fecha original.
       6. Que no solape con otras tareas programadas del usuario (`task_schedule_overlap`).
       7. Que no entre en conflicto con eventos de los calendarios externos seleccionados (`calendar_event_conflict`).
       8. Que cada día local afectado por el intervalo y sus márgenes tenga cobertura en una ventana sincronizada de la generación actual, reciente (últimas 24 horas), sin errores y con conexión vigente. Si no se cumple, rechaza con `calendar_unverified`. La aceptación explícita (`p_accept_unverified_calendars = true`) omite **solo cobertura/frescura**; conserva propiedad, versión, estado, duración, disponibilidad, vencimiento vigente, márgenes, conflictos entre tareas y eventos externos ya conocidos de la generación actual. No considera libre un evento conocido por el hecho de que su caché esté desactualizada.
   - **Limitación documentada de calendarios externos**: La validación de conflictos con eventos de Google o iCloud se efectúa sobre la última copia sincronizada almacenada en Supabase. Ordia no escribe eventos en Google Calendar ni iCloud, ni puede bloquear modificaciones externas realizadas directamente en esos proveedores con posterioridad a la sincronización. Si una sincronización posterior revela un conflicto externo, la interfaz de Calendario lo señala con un distintivo para que el usuario pueda reprogramar la tarea sin moverla automáticamente.

### Datos, sincronización y migración de tareas

`supabase/migrations/20261027172426_add_personal_tasks.sql` crea `personal_tasks`, sus índices, restricciones, trigger de validación y RPC idempotente de creación. La migración fue creada con `supabase migration new`, revisada con dry-run y aplicada una sola vez mediante CLI al proyecto **Ordia** (`dedtyhomynsmvatfnshs`). Al verificar la etapa de tareas coincidían las siete migraciones existentes entonces; no se modificaron las seis anteriores.

RLS restringe SELECT, INSERT y UPDATE al propietario. Los privilegios por columna impiden asignar o cambiar `user_id`, identidad, fechas de auditoría o finalización desde el cliente. El trigger registra finalización y baja con hora del servidor y protege identidad y registros eliminados. No se otorga DELETE ni acceso de tabla a `anon`. `create_personal_task` usa `SECURITY INVOKER` y una clave de petición única por usuario: doble envío o reintento devuelve la misma tarea.

`personal_tasks` pertenece a `supabase_realtime`. El contexto escucha INSERT y UPDATE filtrados por usuario, incluida la baja lógica, y vuelve a consultar al conectar/reconectar, al recuperar conexión, foco o visibilidad. El estado se monta con una clave de usuario distinta en cada sesión, invalida respuestas anteriores y libera el canal al salir. No necesita calendarios ni otra conexión externa. Esta estrategia sigue la documentación de [Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes) y [RLS](https://supabase.com/docs/guides/database/postgres/row-level-security).

### Verificaciones de tareas y planificación

- Pasaron `pnpm typecheck`, `pnpm lint`, `pnpm test` (177 pruebas en 24 archivos), `pnpm build` y `git diff --check` en la revisión puntual del planificador del 28 de octubre de 2026. La compilación conserva un aviso no bloqueante por un chunk de más de 500 kB.
- Vitest cubre creación/edición, conservación ante errores, confirmación de descarte/eliminación, foco, bloqueo de doble envío, checklist, completar/desmarcar, búsqueda/prioridad, tareas sin fechas, programación pasada, vencimiento hoy, cambio de día/mes/año en Bogotá y conversión horaria. Incluye también cálculo de huecos y disponibilidad personal, márgenes preventivos, eventos de todo el día, reprogramación tardía, cobertura de 7 días, reloj en tiempo real, eventos en curso simultáneos (>5) y manejo de errores de concurrencia y calendarios no verificados. Son pruebas unitarias y de interfaz con mocks.
- En PostgreSQL remoto real pasó `supabase/checks/personal_tasks_integration.sql` y `supabase/checks/task_scheduling_concurrency.sql`:
  - `personal_tasks_integration.sql`: creación y reintento idempotente, edición, completar/desmarcar, fechas exactas, validaciones, restricciones de propietario/finalización, aislamiento A/B, baja lógica e inaccesibilidad de `anon`.
  - `task_scheduling_concurrency.sql`: pese a su nombre histórico, son comprobaciones **secuenciales en una única transacción**, no una carrera. Comprueba rechazo de solapamientos por RPC, `UPDATE` e `INSERT`, franjas, márgenes, conflicto con un evento de Google y aislamiento A/B. Se volvió a ejecutar y pasó en esta revisión.
  - Ambas pruebas crean fixtures dentro de una transacción, ejecutan las operaciones de tareas con rol `authenticated` y terminan con `ROLLBACK`. La preparación de usuarios/cachés requiere privilegios administrativos; no son sesiones Supabase Auth/JWT reales de navegador.
- También pasó en Ordia `supabase/checks/task_scheduling_guards.sql`, **secuencial**, con comprobación exacta de SQLSTATE y mensaje. Verifica reprogramación de vencida conservando `due_on`, rechazo de fechas posteriores a un vencimiento vigente (incluido hoy), copia externa vieja o sin cobertura, y aceptación solo de esa advertencia. Incluso aceptando rechaza pasado, duración cero, falta de disponibilidad, horario fuera de franja, tarea completada/versión antigua, solapamiento propio, margen de 15 minutos, eventos conocidos de Google/iCloud (incluido todo el día y conexión que requiere reconexión), tarea ajena y cambio de propietario. Finalizó con `ROLLBACK` y cero usuarios fixture. Son cachés de prueba; no llama a Google ni Apple.
- Se corrigió únicamente la clasificación de errores del servicio frontend: los códigos compartidos `22023` y `23P01` ocultaban errores de vencimiento, pasado, duración y eventos detrás de mensajes de disponibilidad u otra tarea. Las pruebas reprodujeron cuatro fallos antes de corregirlos. Vitest comprueba ahora los mensajes específicos, la transmisión explícita de la aceptación, el rechazo posterior de un conflicto conocido y la etiqueta de reprogramación tardía sin cambiar el vencimiento. Incluye el cambio de año a las 00:00 de Bogotá; estas son pruebas con mocks/cálculo local, distintas de las SQL reales.
- Se inspeccionaron RLS, políticas, privilegios por columna, funciones invocadoras, triggers y publicación Realtime. `supabase db lint --linked` terminó sin hallazgos. El asesor de seguridad mantiene únicamente el aviso preexistente de [Leaked Password Protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
- Docker Desktop no tenía el motor activo, por lo que no se ejecutó la suite local de PostgreSQL. La prueba SQL aislada se puede repetir localmente con `pnpm exec supabase db query --local --file supabase/checks/personal_tasks_integration.sql` después de iniciar Supabase; está separada de la suite pgTAP.
- El usuario confirmó el funcionamiento real de tareas y checklist. La revisión automatizada no accedió a una sesión autenticada verificable para repetirlo visualmente; no se reutilizó una ventana identificada solo por su título. La entrega mediante WebSockets entre dos sesiones reales y la prueba autenticada del frontend publicado siguen en la lista manual.

### Carrera real entre conexiones PostgreSQL — revisión del 28 de octubre

Se verificó **Ordia — `dedtyhomynsmvatfnshs`**, PostgreSQL 17.11, mediante MCP Personales y CLI enlazada. El historial conserva las 13 migraciones locales/remotas, incluidas `20261028020000_add_task_scheduling_suggestions` y `20261028130644_serialize_task_scheduling_conflicts`. Esta revisión no creó, modificó ni aplicó migraciones, ni desplegó servicios.

`scripts/check-task-scheduling-concurrency.mjs` abre dos conexiones PostgreSQL independientes con `postgres` 3.4.9 y una tercera coordinadora. Ambas programaciones usan `SET LOCAL ROLE authenticated`, el mismo `auth.uid()` fixture y aislamiento **READ COMMITTED**. Son conexiones SQL reales, no mocks ni dos sesiones Auth/JWT de navegador. La preparación/limpieza usa el rol administrativo temporal de la CLI, con credenciales solo en memoria, destino comprobado y TLS validado con la CA oficial de Supabase.

La conexión A escribe y mantiene abierta su transacción. Antes de permitir su commit, la coordinadora comprueba PID distintos, que B espera un candado advisory de A (`pg_blocking_pids` y `pg_locks`) y que la escritura de A todavía no es visible desde otra conexión. Luego libera A: su commit se confirma y B detecta `task_schedule_overlap` (`23P01`) al continuar, dejando intacta su tarea.

| Escritura A → B | Incompatibilidad | Espera de B observada | Resultado |
| --- | --- | --- | --- |
| RPC → RPC | Intervalos superpuestos | 3414 ms | Solo A confirma |
| RPC → UPDATE manual | Intervalos superpuestos | 989 ms | Solo A confirma |
| UPDATE manual → RPC | Intervalos superpuestos | 995 ms | Solo A confirma |
| RPC → RPC | Sin superposición, separación 10 min con margen 15 | 988 ms | Solo A confirma |

En la ejecución final los PID fueron 211544 y 211546. Cada escenario terminó con una sola tarea programada; después se eliminó exclusivamente el usuario aleatorio creado por el arnés y sus datos en cascada. Se comprobó cero usuarios, tareas y preferencias fixture. El recibo sin credenciales queda en `tmp/planner-race-<uuid>/result.json` (ignorado por Git).

Para repetir, con la CLI ya autenticada y enlazada a Ordia:

```sh
node scripts/check-task-scheduling-concurrency.mjs
pnpm exec supabase db query --linked --project-ref dedtyhomynsmvatfnshs --file supabase/checks/task_scheduling_guards.sql
```

La RPC y el `UPDATE` manual toman primero la fila propia y después el mismo candado transaccional del usuario. La consulta de conflictos no bloquea las filas de otras tareas. Ambas funciones son `VOLATILE` e invocadoras: bajo READ COMMITTED, la consulta posterior a la espera ve el commit ganador, como confirmó la carrera RPC/trigger. Véanse [aislamiento de PostgreSQL](https://www.postgresql.org/docs/17/transaction-iso.html), [bloqueos consultivos](https://www.postgresql.org/docs/17/explicit-locking.html#ADVISORY-LOCKS) y [visibilidad en funciones VOLATILE](https://www.postgresql.org/docs/17/xfunc-volatility.html).

El alcance comprobado son operaciones sobre **una tarea por transacción** con el aislamiento predeterminado de la aplicación. No se verificaron escrituras administrativas masivas, transacciones manuales que bloqueen varias tareas en otro orden ni otros niveles de aislamiento; no se extiende la garantía a esos casos. Tampoco se bloquean cambios simultáneos en las cuentas externas. Quedan pendientes la revisión visual del planificador en celular/computador y la prueba WebSocket con dos sesiones Auth reales. En esa revisión puntual previa no hubo push ni despliegue; la entrega posterior se publica mediante la integración Git descrita al final.

Para la comprobación manual, ejecuta `pnpm dev` y abre `http://localhost:5173`:

1. Con A, crea tareas sin fechas, con vencimiento ayer/hoy/mañana, programadas hoy y programadas en el pasado sin vencimiento. Confirma las cuatro vistas, búsqueda y prioridad. Prueba un título largo en celular.
2. En el inicio, comprueba que una tarea programada hoy y con vencimiento hoy aparezca una sola vez. Márcala y verifica que desaparezca de pendientes y figure en Completadas con hora de Bogotá. Desmárcala y confirma que vuelva sin fecha de finalización actual.
3. Edita, cancela el descarte de cambios y simula desconexión al guardar. Lo escrito debe conservarse. Elimina solo tareas de prueba tras confirmar; comprueba también la cancelación.
4. Abre dos sesiones normales de A y verifica creación, edición, completar, desmarcar y eliminación lógica sin recargar. Desconecta/reconecta la segunda y verifica recuperación completa.
5. Inicia B en otro perfil y luego cambia de A a B en la misma ventana. Comprueba que B no vea datos/eventos de A, incluidos durante carga. Esta prueba con sesiones Auth reales queda pendiente.
6. En computador y celular, revisa foco inicial/retorno, Tab y Escape, desplazamiento del diálogo, teclado de fecha/hora, navegación y ausencia de desbordamientos. Al volver tras medianoche, vencidas y checklist deben corresponder al día de Bogotá.

## Calendario privado de iCloud — solo visualización

La sección `/calendario` ofrece agenda por día o semana, navegación Anterior/Siguiente/Hoy, selección de calendarios y detalle de eventos. Presenta título, inicio/fin, origen, color y ubicación; el detalle muestra la descripción como texto y solo admite enlaces HTTP/HTTPS sin credenciales. No contiene controles para crear, editar o eliminar eventos en Apple. El inicio incluye una lista separada con hasta cinco eventos de hoy y un enlace al calendario completo; no los convierte en tareas ni permite marcarlos como realizados.

### Método de conexión y requisitos de Apple

Ordia usa **CalDAV desde una Edge Function**, con correo de Apple Account y contraseña específica de aplicación. El correo puede ser diferente al usado para entrar en Ordia. Apple exige doble factor para generar esa contraseña. Apple también documenta autorización de cuenta para aplicaciones compatibles, pero Ordia no está integrado en ese programa: no se ha inventado un OAuth ni se usa “Iniciar sesión con Apple” para obtener acceso a Calendar. Véanse [contraseñas específicas](https://support.apple.com/102654) y [acceso desde aplicaciones de terceros](https://support.apple.com/121539).

Se mantiene una única conexión por usuario. No se aceptan enlaces ICS públicos como sustituto. Solo se consultan calendarios almacenados en iCloud y accesibles a esa cuenta, incluidos compartidos cuando Apple permite su lectura. Los calendarios locales del dispositivo o de otro proveedor añadidos a la app Calendario de Apple no se convierten en calendarios de iCloud.

**La contraseña específica no tiene un permiso técnico de solo lectura.** Puede autorizar más capacidades; es Ordia quien implementa exclusivamente `PROPFIND`, `REPORT` y `GET`. Nunca se solicita la contraseña principal del Apple Account. Para revocar una contraseña específica, abre Apple Account → Inicio de sesión y seguridad → Contraseñas específicas de aplicaciones y elimina la creada para Ordia. Cambiar la contraseña principal de Apple revoca las específicas y exige reconectar.

### Seguridad y modelo de datos

Las migraciones **`20261027174659_add_private_icloud_calendar.sql`** y **`20261027181431_harden_icloud_sync_lease_validation.sql`** fueron creadas mediante la CLI, revisadas con dry-run y aplicadas una sola vez a **Ordia — `dedtyhomynsmvatfnshs`**. La segunda añade el rechazo explícito de reservas vacías antes del commit. Al cerrar iCloud había nueve migraciones coincidentes; Google añade dos, sin editar las anteriores.

- `icloud_connections` guarda estado, generación de conexión y códigos de error seguros. No guarda el correo ni la contraseña.
- `icloud_calendars`, `icloud_windows` e `icloud_events` contienen únicamente metadatos y copias consultables por su propietario. Las cuatro tablas públicas tienen RLS de propietario y solo `SELECT` para `authenticated`; `anon` no tiene acceso. El navegador no puede escribir eventos, cambiar propietarios ni ejecutar RPC de servidor.
- `private.icloud_credentials` guarda correo y contraseña juntos, cifrados con **AES-256-GCM**, nonce aleatorio y autenticación vinculada al usuario. `ICLOUD_CREDENTIAL_ENCRYPTION_KEY` vive exclusivamente en los secretos de la Edge Function. La contraseña guardada no se puede recuperar desde el frontend.
- `private.icloud_remote_calendars` conserva destinos descubiertos; `private.icloud_resources` conserva iCalendar/ETags para reutilización; `private.icloud_operations` aplica reservas y límites. Estas tablas tienen RLS sin políticas de cliente y sin privilegios para `anon`/`authenticated`. Solo el servidor accede con su rol de servicio.
- Las cuatro RPC de servidor son `SECURITY INVOKER`, con `search_path` vacío y ejecución reservada a `service_role`. La función valida la sesión mediante `auth.getUser(bearer)` antes de usar ese rol; toma el propietario del usuario validado e ignora cualquier `user_id` enviado por el cliente. No usa metadatos editables para autorizar.
- Las solicitudes de Apple salen exclusivamente del servidor. El descubrimiento parte de `https://caldav.icloud.com/`, resuelve `current-user-principal`, `calendar-home-set` y colecciones CalDAV. El shard asignado no está fijado. Solo se permiten HTTPS, el host de entrada y hosts `pNN`/`pNNN-caldav.icloud.com`, puerto estándar y sin usuario/contraseña/query/fragmento en la URL. Cada redirección se valida antes de reenviar Authorization; los objetos deben pertenecer a la colección descubierta.
- Los errores no incluyen respuestas originales de Apple, URLs privadas, cabeceras ni credenciales. El formulario mantiene la contraseña solo en memoria hasta conectar/cerrarlo, sin localStorage ni logs. La función usa CORS para localhost/127.0.0.1:5173 y el dominio de prueba de Ordia; CORS no sustituye la validación de sesión.

### Fechas, recurrencias y sincronización

La interpretación usa **ICAL.js 2.2.1**, XML validado con **fast-xml-parser 5.11.2** y zonas IANA mediante **Temporal polyfill 0.5.1**, con versiones y lockfiles conservados. Se respetan VTIMEZONE, UTC, TZID, horario de verano, RRULE, RDATE/EXDATE y excepciones RECURRENCE-ID, incluidas cancelaciones y `THISANDFUTURE`. Los horarios flotantes se interpretan en Bogotá. Los eventos de todo el día mantienen fechas `date` con fin exclusivo; los instantes usan `timestamptz`. La visualización utiliza America/Bogota. Referencias: [CalDAV, RFC 4791](https://www.rfc-editor.org/rfc/rfc4791), [descubrimiento, RFC 6764](https://www.rfc-editor.org/rfc/rfc6764), [iCalendar, RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) e [ICAL.js](https://kewisch.github.io/ical.js/api/ICAL.Event.html).

Cada consulta cubre una semana canónica de lunes a lunes, en el rango de navegación 1900–2099. Día e inicio usan esa misma ventana, y navegar consulta semanas adicionales. Se conservan las **12 ventanas sincronizadas más recientemente** por conexión; no se importa de golpe todo el historial.

El servidor obtiene por `calendar-query` el inventario completo del rango y sus ETags. Reutiliza recursos sin cambios y hace GET condicional cuando corresponde; si faltan ETags, descarga el objeto de nuevo. No presupone soporte de sync-token. Una respuesta completa y válida permite actualizar o retirar instancias. XML incompleto, HTTP fallido, recurso desaparecido entre REPORT/GET, errores de interpretación o límites excedidos abortan la operación: **no se deducen eliminaciones ni se reemplaza la copia anterior**.

El commit de la ventana, eventos y recursos es transaccional, con una clave estable por calendario/UID/instancia. Una reserva por usuario evita operaciones simultáneas durante 90 segundos. Se limitan 5 intentos de conexión y 30 operaciones en 15 minutos, hasta 15 calendarios seleccionados, 300 recursos/4.000 instancias por ventana, 2 MB por respuesta y 8 MB de iCalendar total. La expansión también tiene un límite de iteraciones/tiempo; si se supera, se indica el error y se conserva la copia. Estos límites pueden requerir seleccionar menos calendarios en cuentas grandes.

Al abrir o volver a la agenda se intenta actualizar, como máximo una vez por minuto por vista; la caché de servidor evita otra consulta dentro de 60 s (15 s al pulsar Actualizar). La fecha de última sincronización identifica la ventana visible. Un fallo mantiene visibles los datos válidos y señala que pueden estar desactualizados. No hay cron ni conexión WebSocket directa a Apple: **Realtime comunica cambios de la copia en Supabase** mediante INSERT/UPDATE del estado de conexión, filtrados por propietario. Los otros dispositivos vuelven a leer la copia tras el commit, incluidas eliminaciones; no se escuchan DELETE ni se publican credenciales. Se limpian canales/respuestas al salir o cambiar de sesión.

“Actualizar lista de calendarios” repite el descubrimiento completo y conserva selección de los calendarios todavía accesibles; nuevos calendarios quedan sin seleccionar. Cambiar selección invalida las ventanas para que no sigan apareciendo eventos deseleccionados. Reconectar reemplaza credenciales y requiere volver a elegir calendarios.

**Desconectar iCloud** elimina credenciales, destinos y copias de eventos de Ordia. Conserva un estado desconectado sin datos sensibles para avisar a otros dispositivos. Invalida la reserva y la generación antes de que una sincronización en curso pueda hacer commit. No toca eventos originales ni tareas. Una credencial rechazada marca reconexión requerida y detiene actualizaciones automáticas, sin reintentar Apple indefinidamente.

### Configuración del servidor y estado comprobado

En la etapa de iCloud se configuró `ICLOUD_CREDENTIAL_ENCRYPTION_KEY` y se desplegó `icloud-calendar`, únicamente en Ordia. En el cierre se verificó **versión 5, ACTIVE**, con todos sus módulos idénticos al código local. No fue necesario modificar ni volver a desplegar esa función. La clave local vive en `supabase/functions/.env.icloud`, ignorado por Git; no se imprimió su valor. No requiere variables `VITE_` nuevas.

Para reproducir una instalación nueva —no regeneres la clave ya configurada—:

```powershell
pnpm icloud:generate-key
pnpm exec supabase secrets set --env-file supabase/functions/.env.icloud --project-ref dedtyhomynsmvatfnshs
pnpm exec supabase functions deploy icloud-calendar --project-ref dedtyhomynsmvatfnshs --use-api --no-verify-jwt
```

`verify_jwt=false` evita depender del verificador legacy de la plataforma; **no abre el endpoint**: cada operación exige un bearer válido y `auth.getUser` comprueba la sesión. No reemplaces una clave de cifrado en uso: sin ella no pueden descifrarse las credenciales existentes. Conserva su respaldo fuera de Git; una rotación necesitaría recifrado o reconexión de los usuarios. No copies al frontend el archivo de secretos ni claves del servidor.

Comprobado realmente:

- Al cerrar la etapa iCloud pasaron `typecheck`, `lint`, **103 pruebas Vitest en 17 archivos** y `build`. El resultado ampliado con Google se documenta más abajo. `git diff --check` de archivos rastreados pasó; la revisión adicional de archivos nuevos detectó una línea vacía final sin efecto SQL en `20261027181431_harden_icloud_sync_lease_validation.sql`, que se conserva sin editar porque ya se aplicó.
- `deno check` de la función y sus módulos con Deno 2.9.6, seguido de despliegue mediante API sin depender de Docker.
- Función remota: `401` sin sesión y con token inválido; preflight `204` para localhost y `403` para un origen ajeno. No se enviaron credenciales de Apple.
- PostgreSQL real: `supabase/checks/icloud_calendar_integration.sql` pasó con fixtures A/B exclusivos y ROLLBACK en la etapa anterior. Verifica propiedad/RLS con rol `authenticated`, credenciales inaccesibles al cliente, RPC reservadas, reservas simultáneas, idempotencia, reemplazo atómico, conservación ante fallo, selección ajena rechazada, estado de credencial revocada, límites y desconexión durante sync sin restauración posterior. El rol de servicio se usa solo para emular operaciones del servidor; no demuestra RLS. La comprobación A/B sí cambia a `authenticated`. Los fixtures se retiraron; la ausencia de conexiones reales correspondía a aquel momento, antes de la prueba del usuario.
- `supabase db lint` de `public,private` sin hallazgos; RLS y privilegios inspeccionados. El asesor presenta cuatro avisos **informativos esperados** de [RLS sin políticas](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy) para las tablas privadas (denegación por defecto) y el aviso preexistente de protección de contraseñas filtradas.
- Tests con respuestas CalDAV simuladas: descubrimiento, reutilización ETag, redirecciones no permitidas, 401/403, XML incompleto, cifrado y propietario, todo el día/fin exclusivo, zonas y DST, RRULE/UNTIL/EXDATE, excepciones movidas/canceladas/THISANDFUTURE, repetición sin duplicados y desconexión mientras llega una respuesta antigua. Las pruebas de interfaz cubren formularios, errores, selección vacía y detalle sin HTML ejecutable ni enlaces inseguros.

**El usuario informó que probó satisfactoriamente la conexión real de iCloud.** Se conserva esa conexión. Esta etapa comprueba por regresión automatizada el código de iCloud; no repite su autorización ni accede a sus credenciales. Compartidos, cambios, revocación, dos sesiones Auth normales y revisión visual siguen en la lista manual si no se han comprobado por separado. No se ejecutó PostgreSQL local porque el motor Docker no estaba activo. Las pruebas SQL y respuestas simuladas no sustituyen estas comprobaciones.

### Probar tu propia cuenta iCloud

1. Abre `https://ordia-seven.vercel.app` e inicia sesión en Ordia. Para desarrollo, ejecuta `pnpm dev` y abre `http://localhost:5173`.
2. Entra en Calendario → Conectar iCloud. Con doble factor activo, genera una contraseña específica para Ordia en [Apple Account](https://account.apple.com/). Introduce el correo y esa contraseña **solo en el formulario de Ordia**, nunca en el chat.
3. Tras validar el descubrimiento, pulsa Elegir calendarios, selecciona cuáles mostrar y guarda. Comprueba Día/Semana, Anterior/Siguiente/Hoy, todo el día, eventos que cruzan medianoche, detalle, origen, ubicación y Eventos de hoy en el inicio. El horario se muestra en Bogotá.
4. Edita o cancela un evento de prueba desde tu calendario habitual y pulsa Actualizar en Ordia (espera al menos 15 s entre intentos). Comprueba que no se duplique ni se retire por un fallo de conexión. Haz también una prueba con recurrencia/excepción y un calendario compartido realmente accesible.
5. Abre otra sesión del mismo usuario y comprueba que reciba la copia sincronizada. Con otro usuario de Ordia, confirma que no vea ni calendarios ni eventos de la primera cuenta. Cambia de sesión en la misma ventana y verifica que se limpien los datos.
6. Prueba desconectar mientras Actualizar está en curso: no deben reaparecer eventos. Después revoca la contraseña específica en Apple. Para probar la detección de revocación, revócala mientras sigues conectado y comprueba que Actualizar solicite reconectar, sin un ciclo de intentos.
7. Revisa el diálogo y la selección en celular y computador: foco, Tab/Escape, confirmaciones, campos legibles y ausencia de desbordamientos.

Para repetir solo la prueba transaccional aislada después de revisar su alcance:

```powershell
Get-Content supabase/.temp/project-ref # Debe ser dedtyhomynsmvatfnshs
pnpm exec supabase db query --linked --file supabase/checks/icloud_calendar_integration.sql
```

## Google Calendar en la agenda unificada — solo lectura

La misma sección **Calendario** y **Eventos de hoy** combina los calendarios seleccionados de iCloud, Google o ambos. Cada evento identifica proveedor, calendario y color; conserva vistas diaria/semanal, todo el día y detalle de lectura. Identificadores internos incluyen proveedor, conexión, calendario e instancia: dos eventos de igual título y horario se muestran por separado. Cada proveedor tiene selección, estado, errores y última sincronización propios. **Actualizar ambos** no impide consultar una copia válida si el otro proveedor falla. Desconectar Google conserva iCloud, tareas y finanzas.

### Resumen «Eventos de hoy»

El resumen en la página de inicio presenta los eventos del día en `America/Bogota`:
- Muestra únicamente eventos en curso (`starts_at <= now < ends_at`) o que todavía no hayan comenzado (`starts_at > now`), ocultando del resumen aquellos cuya hora de fin sea menor o igual a la actual (`ends_at <= now`).
- Identifica los eventos en curso con la etiqueta «En curso» y los coloca primero, conservando todos los eventos simultáneos; después muestra los próximos ordenados por inicio.
- Mantiene los eventos de todo el día en un grupo diferenciado durante su día correspondiente, respetando la fecha final exclusiva.
- Incluye correctamente eventos que comenzaron el día anterior y continúan hoy.
- Aplica una regla explícita y documentada para eventos sin fin válido sin inventar duraciones: los eventos con horario sin fin válido se tratan como puntuales (`ends_at = starts_at`), considerándose finalizados al alcanzar su hora de inicio; los eventos de todo el día sin fin válido toman como fin exclusivo el día calendario siguiente (`start_on + 1 día`).
- Se actualiza automáticamente mientras la app permanece abierta (al menos cada minuto) y al volver del segundo plano (`focus` y `visibilitychange`), manejando también el cambio de día a medianoche.
- El reloj local reutiliza los eventos cargados en memoria y el mecanismo de sincronización existente sin consultar a los proveedores cada minuto.
- Si hay más de 5 eventos, los eventos en curso nunca se ocultan por el límite (se muestran todos los eventos en curso con su distintivo «En curso» aunque haya más de 5 simultáneos). El límite aplica únicamente a los eventos próximos restantes. La nota inferior informa con exactitud la cantidad visible sobre el total elegible («Mostrando N de M. Consulta el resto en Calendario»).
- Si no quedan eventos, muestra «No tienes más eventos programados para hoy», diferenciándolo de la falta de calendarios conectados o estados de carga y error.
- La sección **Calendario** continúa permitiendo consultar todos los eventos, incluidos los que ya terminaron.

### Autorización y privacidad

El acceso a Ordia sigue usando correo y contraseña. **Conectar Google Calendar** autoriza una cuenta Google por usuario; su correo puede ser diferente. No usa Supabase Social Login, no vincula identidades de Ordia ni decide propiedad por correo. Solicita `calendar.calendarlist.readonly` y `calendar.events.readonly`, además de `openid`/`email` para identificar de forma estable la cuenta Google por `sub`. No solicita permisos de escritura ni perfil completo. Véanse [permisos de Calendar](https://developers.google.com/workspace/calendar/api/auth) y [OAuth de servidor](https://developers.google.com/identity/protocols/oauth2/web-server).

El servidor crea un `state` aleatorio de 256 bits, de un solo uso y con caducidad de 10 minutos, vinculado al usuario autenticado y a la generación de conexión. Conserva únicamente su hash y un verifier PKCE cifrado. El navegador envía el ticket efímero mediante una navegación POST desde un origen permitido; el servidor lo activa una sola vez, fija una cookie `HttpOnly; Secure; SameSite=Lax` y redirige a Google con PKCE S256. El callback exige esa cookie, consume el state antes de intercambiar el código y comprueba vencimiento, generación y origen de retorno. El navegador vuelve únicamente a `/calendario?google=connected`, `denied` o `error` en su origen inicial. En caso de error añade `google_error_id`, un UUID aleatorio de diagnóstico sin datos del usuario. El código OAuth llega al callback del servidor como establece el protocolo; los access/refresh tokens nunca llegan al frontend ni a URLs de la aplicación. Los logs propios excluyen cuerpos, cabeceras, códigos OAuth y credenciales.

Los tokens de acceso y renovación y la identidad Google se cifran con AES-256-GCM, nonce aleatorio y autenticación ligada al usuario. Viven en `private.google_credentials`, con una clave exclusiva `GOOGLE_CREDENTIAL_ENCRYPTION_KEY` en los secretos de servidor. Un refresh token existente se conserva si Google no devuelve otro, únicamente cuando coincide el `sub`; no se traslada a una cuenta distinta. La renovación ocurre antes de caducar y persiste bajo la reserva de sincronización. Una revocación/permisos insuficientes exige reconectar, conservando la última copia válida.

Las migraciones **`20261028005021_add_google_calendar_readonly.sql`** y **`20261028011247_preserve_google_snapshot_on_discovery.sql`** fueron creadas con CLI, revisadas mediante dry-run y aplicadas una sola vez en **Ordia — `dedtyhomynsmvatfnshs`**. La segunda conserva la copia válida al redescubrir calendarios, incluso si falla después la consulta de eventos. Local y remoto tienen once migraciones coincidentes; el dry-run posterior quedó sin pendientes. No se editaron migraciones aplicadas ni se modificó otro proyecto.

- `google_connections`, `google_calendars`, `google_windows` y `google_events` tienen RLS de propietario, solo `SELECT` para `authenticated` y ningún acceso para `anon`.
- `private.google_credentials`, `google_remote_calendars`, `google_operations` y `google_oauth_states` tienen RLS con denegación por defecto y ningún permiso de cliente. Verifiers y tokens no se consultan desde el navegador.
- Las diez RPC son `SECURITY INVOKER`, `search_path` vacío y ejecución exclusiva de servidor. La Edge Function comprueba `auth.getUser` antes de operar en nombre del usuario; las dos fases públicas OAuth dependen del state/origen/cookie, no de un propietario enviado por el navegador.
- Realtime publica solo `google_connections`: INSERT/UPDATE filtrados por usuario disparan una nueva lectura de la copia, incluyendo eliminaciones. No se publican secretos ni se escuchan DELETE. Los canales y respuestas se invalidan al cambiar de usuario o salir; foco, conexión y visibilidad recuperan datos completos.

### Consultas, recurrencias y límites

Cada consulta Google obtiene una semana completa lunes–lunes en Bogotá. Usa `events.list` con `singleEvents=true` para que Google expanda recurrencias y excepciones, y descarta instancias `cancelled`. Recorre todas las páginas de calendarios y eventos, incluso páginas vacías con `nextPageToken`. Conserva ID de evento, serie, inicio original de instancia y objetos originales de inicio/fin; los instantes se guardan como `timestamptz`, y todo el día como fechas con fin exclusivo. Muestra los horarios en America/Bogota. No usa sync tokens incrementales porque la agenda consulta rangos: [restricciones de `events.list`](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

Solo una respuesta completa válida sustituye atómicamente la ventana. Un error, permiso retirado, página incompleta o límite excedido conserva la copia anterior. **Actualizar lista de Google** vuelve a descubrir calendarios, conserva selección y copia de los que siguen accesibles y deja los nuevos sin seleccionar; únicamente retira los calendarios cuya ausencia confirma una lista completa, junto con sus eventos. La consulta posterior de eventos puede fallar sin borrar la copia restante. Cambiar selección o reconectar invalida ventanas para no presentar eventos de una selección anterior; reconectar requiere elegir calendarios otra vez. No hay cron ni webhook de Google: actualiza al abrir/volver, manualmente y a través de Realtime de la copia de Supabase.

Límites por usuario/proveedor: 15 calendarios seleccionados, 100 descubiertos, 4.000 instancias por semana, 100 páginas como máximo y 4 MB por respuesta. Se guardan las 12 ventanas sincronizadas más recientemente. Una reserva de 90 s impide commits simultáneos; las solicitudes externas tienen 12 s por petición y 60 s por operación. Hay 30 operaciones y 5 inicios OAuth en 15 minutos. La caché evita otra consulta externa antes de 60 s, o 15 s en actualización manual. Si se supera un límite, seleccionar menos calendarios permite reintentar sin perder la copia.

**Desconectar Google** invalida la reserva/state y elimina tokens, calendarios y ventanas propios en una transacción antes de intentar revocar en Google. Una respuesta antigua no puede restaurarlos. Si Google no confirma revocación, Ordia lo indica y ofrece [revisar conexiones de Google](https://myaccount.google.com/connections). La revocación no borra eventos originales ni modifica iCloud.

### Estado real del servidor

`google-calendar` está desplegada en Ordia, **versión 5 ACTIVE**, con todos sus módulos idénticos al código local, `verify_jwt=false` y autenticación propia para las acciones del navegador. Las rutas `/authorize` y `/callback` atienden exclusivamente el protocolo OAuth. La clave de cifrado vive en `supabase/functions/.env.google-key` (ignorado) y en Ordia. **`GOOGLE_OAUTH_CLIENT_ID` y `GOOGLE_OAUTH_CLIENT_SECRET` ya fueron configurados por el usuario mediante el script**. Se verificó la presencia de los tres secretos y su coincidencia con los archivos locales comparando digests sin mostrar valores. No se cambiaron credenciales ni se modificó iCloud. No hay variables `VITE_` nuevas.

El usuario habilitó **Google Calendar API** en el proyecto Google Cloud `selaure` (Selaure), que contiene el cliente **Ordia Web**, y confirmó después la conexión y consulta real de Google Calendar. Su identidad se había contrastado por huella con el Client ID configurado, sin exponerlo. Este proyecto Google Cloud es distinto del proyecto Supabase Ordia. El anterior fallo `accessNotConfigured` quedó resuelto mediante esa habilitación; no fue necesario crear otro cliente ni cambiar secretos.

Para una instalación nueva exclusivamente, sin reemplazar la clave ya activa:

```powershell
pnpm google:generate-key
pnpm exec supabase secrets set --env-file supabase/functions/.env.google-key --project-ref dedtyhomynsmvatfnshs
pnpm exec supabase functions deploy google-calendar --project-ref dedtyhomynsmvatfnshs --use-api --no-verify-jwt
```

Conserva un respaldo privado de la clave; una rotación requiere recifrar o reconectar. `.env.google`, `.env.google-key`, `.env.icloud` y `.env.local` están ignorados. Nunca los copies a Git, chat o Vercel. No habilites Google como proveedor Auth de Supabase para esta integración.

### Configurar Google Cloud en una instalación nueva

El usuario ya completó la creación del cliente Web y la carga de credenciales en Ordia. No hay que repetir estos pasos ni reemplazarlas para diagnosticar un fallo.

1. En [Google Cloud Console](https://console.cloud.google.com/), crea o selecciona un proyecto **dedicado a Ordia**, verificando su identidad; no uses credenciales de otra aplicación. En **APIs y servicios → Biblioteca**, habilita **Google Calendar API**.
2. Abre **Google Auth Platform** (o **Pantalla de consentimiento OAuth**). En **Branding**, indica Ordia, correo de soporte y contacto del desarrollador. El dominio de prueba del frontend es `https://ordia-seven.vercel.app`. Para publicar el consentimiento OAuth fuera del modo Testing, harán falta los dominios verificables y las páginas públicas exigidas por Google; no se han creado ni supuesto políticas de privacidad públicas.
3. En **Audience**, usa **External / Testing** para una cuenta Google personal. Añade en **Test users** el correo Google que vas a autorizar, aunque sea distinto al de Ordia. Si es una organización Workspace, sus políticas pueden limitar el acceso. En **Data Access**, añade los dos scopes de Calendar de lectura indicados arriba y `openid`/`email`.
4. En **Clients → Create client**, elige **Web application**, nombre `Ordia Calendar`. Registra exactamente este **Authorized redirect URI**, sin barra final:

   ```text
   https://dedtyhomynsmvatfnshs.supabase.co/functions/v1/google-calendar/callback
   ```

   Es el mismo callback para desarrollo local y para `https://ordia-seven.vercel.app`: el retorno final se decide mediante el state validado. No es `/auth/callback` de Supabase Auth. Este flujo no usa Google JavaScript SDK ni requiere un origen JavaScript autorizado; no añadas comodines ni callbacks de otras apps. Se permiten como retorno `http://localhost:5173`, `http://127.0.0.1:5173` y `https://ordia-seven.vercel.app`.
5. Conserva Client ID y Client secret localmente. En una terminal PowerShell 7, desde la carpeta de Ordia, ejecuta:

   ```powershell
   pwsh -NoProfile -File scripts/configure-google-oauth.ps1
   ```

   El script verifica el nombre/ref de Ordia mediante CLI, pide ambos valores con entrada oculta, valida formato, crea `.env.google` ignorado y los carga solo en Ordia sin imprimirlos. No reemplaza un archivo existente. Si se guardó el archivo pero falló la carga, reintenta sin mostrar su contenido:

   ```powershell
   pnpm exec supabase secrets set --env-file supabase/functions/.env.google --project-ref dedtyhomynsmvatfnshs
   ```

   No regeneres la clave de cifrado ni necesitas volver a aplicar migraciones. Si no estás autenticado en la CLI, ejecuta antes `pnpm exec supabase login` en tu terminal y completa su navegador; nunca pegues tokens en el chat.
6. Ejecuta `pnpm dev`, abre `http://localhost:5173/calendario` en Chrome o Safari e inicia sesión en Ordia. Recarga tras configurar secretos. Pulsa **Conectar Google Calendar**, elige la cuenta de prueba y concede los dos permisos de lectura. Usa un navegador normal; no un navegador embebido para el consentimiento. Al volver, elige calendarios Google y conserva la selección iCloud que ya tenías.

En modo **External / Testing**, con estos permisos de Calendar los refresh tokens caducan a los **7 días**; habrá que reconectar. Google limita este modo a 100 usuarios de prueba y puede revocar accesos por otras causas. Para producción con permisos sensibles corresponde revisar publicación/verificación, propiedad de dominios, página de inicio/política de privacidad y justificación de scopes; no se ha solicitado esa verificación. Referencias: [modo de pruebas y duración de tokens](https://developers.google.com/identity/protocols/oauth2#expiration), [consentimiento y usuarios de prueba](https://developers.google.com/workspace/guides/configure-oauth-consent), [verificación de scopes sensibles](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

### Verificaciones de Google y comprobaciones pendientes

- Pasaron `pnpm typecheck`, `pnpm lint`, **124 pruebas Vitest en 22 archivos**, `pnpm build` y `git diff --check` de archivos rastreados. Las pruebas nuevas usan mocks para OAuth/API y UI: PKCE/cifrado, renovación sin perder refresh token, identidad independiente por `sub`, permisos insuficientes, state/cookie inválidos, rutas del gateway, paginación completa/ciclos/fallos, recurrencias expandidas por Google, cancelaciones, todo el día/fin exclusivo, zonas horarias, filtros combinados, eventos de igual título sin fusión, inicio de hoy y cambio de sesión/desconexión con respuestas tardías. Las pruebas iCloud existentes siguen pasando.
- `deno check` de la función y dependencias pasó. En el servidor desplegado se comprobó HTTP `401` sin sesión y con bearer inválido, `403` con origen ajeno y `503 google_configuration_pending` en callback mientras falta el cliente OAuth. Una comprobación remota detectó el prefijo de ruta eliminado por el gateway; se corrigió y se añadió su regresión antes de volver a desplegar.
- PostgreSQL real: `supabase/checks/google_calendar_integration.sql` pasó con fixtures A/B exclusivos y ROLLBACK, también después de la segunda migración. Comprueba estados creados/activados/consumidos, origen/cookie/caducidad/reutilización, commit OAuth único, caché idempotente, reserva exclusiva, persistencia de renovación, conservación ante fallo y tras redescubrir calendarios, rechazo de calendario ajeno y de respuestas antiguas tras desconectar. RLS se comprobó con rol **authenticated y claims A/B**, no con service_role. Es una prueba de PostgreSQL real con identidades simuladas, no sesiones Auth normales ni autorización real de Google. Tras el rollback quedaron **cero fixtures**. No se ejecutaron solicitudes a Google ni se tocaron datos de iCloud.
- Se inspeccionaron RLS, políticas, permisos y Realtime de las ocho tablas nuevas; `supabase db lint --linked --schema public,private --fail-on warning` pasó sin errores. El asesor conserva los avisos informativos esperados de tablas privadas [sin políticas de cliente](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), además del aviso previo de [protección de contraseñas filtradas](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection). No se alteró configuración Auth.
- No había una pestaña de Ordia con URL y sesión autorizada verificables: el título “Ordia” disponible correspondía a una URL de ChatGPT. No se usó para revisar la aplicación ni se accedió a credenciales. Queda pendiente la revisión visual en celular y computador.

Para repetir la comprobación SQL después de revisar sus fixtures/rollback y verificar el enlace:

```powershell
Get-Content supabase/.temp/project-ref # Debe ser dedtyhomynsmvatfnshs
pnpm exec supabase db query --linked --file supabase/checks/google_calendar_integration.sql
```

**El usuario confirmó la conexión y consulta real de Google Calendar después de habilitar la API.** Esto no equivale a una autorización iniciada desde Vercel ni a una prueba en iPhone. Para completar las comprobaciones de publicación y los casos avanzados:

1. Conectar con un correo Google distinto al de Ordia y verificar que la sesión de Ordia siga siendo la misma. Cancelar consentimiento y reconectar; volver atrás/reutilizar callback debe fallar sin reenviar códigos ni tokens a la aplicación.
2. Seleccionar solo iCloud, solo Google, ambos y ninguno. Comprobar color/origen, día/semana/detalle, resumen de hoy y dos eventos distintos de título/horario iguales. Revisar celular/computador: controles sin desbordamiento, diálogos desplazables, foco y teclado.
3. Crear/editar/cancelar desde Google Calendar, nunca desde Ordia, un evento normal, uno de todo el día, una serie con excepción movida/cancelada y uno con otra zona horaria. Actualizar su copia; un fallo de Google debe conservar iCloud y la última copia válida. Probar también cambios de acceso a un calendario compartido y actualizar su lista.
4. Abrir dos sesiones normales del mismo usuario y otra de B. Confirmar Realtime de selección/eventos, recuperación al reconectar y ausencia de datos de A en B; cerrar/cambiar sesión mientras sincroniza debe limpiar los datos inmediatamente.
5. Desconectar Google durante una actualización: no debe reaparecer su copia; iCloud/tareas/finanzas deben conservarse. Confirmar la revocación en Google, reconectar y comprobar la renovación real tras caducar el access token. En Testing repetir consentimiento cuando venza el refresh token.

### Diagnóstico seguro de una conexión fallida

Se investigó el intento del **27 de octubre de 2026, 20:28:46 America/Bogota**: la versión 4 local/remota coincidía; el callback recibió código, state y cookie y respondió con retorno `303` al frontend. El mensaje `google=error` corresponde al bloque posterior al consumo de state. Los registros propios anteriores solo tenían Boot/Shutdown, por lo que no identificaban la causa. No se reutilizó ese código ni se cambiaron secretos por ensayo y error. El primer 403 por usuarios de prueba fue comunicado por el usuario y correspondía a un paso anterior de consentimiento.

La versión 5 añade diagnóstico con esquema cerrado: UUID de solicitud, fase, resultado, código interno, estado HTTP del proveedor y razón conocida de una lista permitida, o SQLSTATE. No registra usuario/correo, state/hash, cookie, verifier/challenge, código OAuth, access/refresh tokens, client secret, cuerpos, stack ni URLs. Los errores desconocidos no incluyen sus mensajes originales. Distingue validación/consumo de state, descifrado PKCE, intercambio/renovación de tokens, validación de respuesta, identidad, refresh token, scopes, lista de calendarios, cifrado y almacenamiento. La referencia aparece en el retorno como `google_error_id` y en la interfaz local; no concede acceso a registros ni datos. Véase [logging de Edge Functions](https://supabase.com/docs/guides/functions/logging).

**Causa confirmada tras repetir la autorización:** la referencia `2063fdf6-347a-442b-b1d5-c31afa90158a` del **27 de octubre de 2026, 20:37:04 America/Bogota** registró `phase=calendar_list`, `upstream_status=403`, `google_reason=accessNotConfigured` y `error_code=google_api_disabled`. En ese intento ya habían pasado state/cookie, descifrado PKCE, intercambio de tokens, consulta de identidad y validación de refresh token/scopes. El fallo ocurría antes de cifrar/guardar la conexión. No había evidencia de un defecto de PKCE o de credenciales; no se modificaron para intentar resolverlo.

Corrección completada por el usuario: habilitó la API en la [ficha verificada de Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=selaure) y completó otra autorización nueva. No requirió volver a cargar secretos ni desplegar la función. Para instalaciones nuevas basta habilitar `calendar-json.googleapis.com`; no se necesitan CalDAV API ni Google Calendar MCP API. Referencia oficial: [habilitar las APIs de Workspace](https://developers.google.com/workspace/guides/enable-apis).

Comprobado durante el diagnóstico: callback idéntico en autorización e intercambio, PKCE conservado desde crear state hasta intercambiar, caducidad de 10 minutos, diez RPC de servidor sin permisos de cliente, tablas privadas inaccesibles y lint PostgreSQL sin errores. Pasaron `typecheck`, `lint`, **129 pruebas en 22 archivos**, `build`, `git diff --check` y `deno check`. Las pruebas nuevas simulan rechazos del endpoint de tokens, API deshabilitada y errores de almacenamiento y comprueban referencia/fase y ausencia de secretos en logs. Eso no demuestra una autorización real completada. En el servidor se probó un callback deliberadamente inválido: lo rechaza con `400 google_oauth_invalid` y referencia, sin consumir un state real ni solicitar tokens.

Para generar un registro nuevo, abre **`https://ordia-seven.vercel.app/calendario`**, o `http://localhost:5173/calendario` con `pnpm dev`, en Chrome o Safari. Recarga, inicia sesión en Ordia y pulsa **Conectar Google Calendar**; completa un intento nuevo con el usuario de prueba. No reutilices una URL vieja de callback. Si vuelve a fallar, informa solo la referencia del error o que terminaste el intento; nunca envíes la URL del callback, códigos ni secretos. El retorno debe volver al mismo origen autorizado donde se inició; no se admiten dominios arbitrarios ni URLs de previews dinámicas.

En Supabase Dashboard → Ordia → Edge Functions → google-calendar → Logs, busca la referencia y el evento `google_oauth`. Consulta exclusivamente los campos seguros del evento propio. No copies la invocación completa ni cabeceras, cookies o query de OAuth. Si el fallo queda en `token_exchange`, el estado HTTP y `google_reason` permitirán decidir qué revisar; si queda en `scope_validation`, `calendar_list` o `connection_store`, se trata de un paso diferente. No desactives state, PKCE, autenticación ni permisos como solución.

## Notificaciones Web Push

Cada usuario puede habilitar varios dispositivos. `push_subscriptions` guarda una fila privada por navegador y `push_notification_attempts` registra los intentos del servidor. RLS permite consultar únicamente los dispositivos propios; las operaciones privilegiadas de entrega están reservadas a `service_role`. Cuando un mismo endpoint se registra para otra cuenta, la fila anterior se desactiva para proteger dispositivos compartidos.

El permiso se solicita únicamente después de pulsar **Activar notificaciones**. La interfaz distingue activadas, desactivadas, permiso denegado, dispositivo no compatible, instalación requerida en iPhone/iPad y configuración VAPID pendiente. Al cerrar sesión se intenta desactivar la fila remota y siempre se cancela la suscripción del proveedor en el navegador; si la red falla, el endpoint queda inválido y el servidor lo desactiva al recibir `404` o `410`.

El service worker muestra textos discretos sin nombre, importe ni identificadores visibles, y al pulsar abre `/gastos-fijos`. Las obligaciones pendientes no cambian saldos por consultar o notificar. Antes de cada envío el servidor vuelve a comprobar que el período siga impago, no esté cancelado y que la suscripción continúe activa.

La política de Bogotá es:

- un aviso un día antes;
- un aviso el día del vencimiento;
- como máximo un intento diario mientras continúe vencido.

La hora objetivo es **08:00 America/Bogota**. El job se ejecuta cada hora y la función acepta procesamiento entre 08:00 y 20:00 para recuperar una ejecución perdida durante el mismo día. No reconstruye avisos antiguos del día anterior: una deuda seguirá entrando en el recordatorio diario de vencidos. La restricción única por dispositivo, obligación, fecha y tipo, junto con una reserva de procesamiento, limita duplicados por reintentos o ejecuciones simultáneas; Web Push no garantiza entrega exactamente una vez.

### Configuración del servidor push

Esta configuración contiene secretos y debe hacerse localmente o en el Dashboard, nunca en Git ni en chats. El generador escribe directamente en archivos ignorados y no imprime las claves.

1. En una instalación nueva, genera el par VAPID, un secreto aleatorio para Cron y el SQL temporal de Vault:

   ```powershell
   pnpm push:generate-keys
   ```

   El comando crea `VITE_VAPID_PUBLIC_KEY` en `.env.local`, guarda los cuatro secretos de servidor en `supabase/functions/.env.push` y prepara `supabase/setup_push_vault.local.sql`. Se detiene sin reemplazar valores existentes.
2. Carga los secretos en Ordia sin imprimirlos:

   ```powershell
   pnpm exec supabase secrets set --env-file supabase/functions/.env.push --project-ref dedtyhomynsmvatfnshs
   ```

3. Despliega la función. `verify_jwt` está desactivado porque el job no representa a un usuario; la función exige `x-ordia-cron-secret` y rechaza llamadas sin el secreto.

   ```powershell
   pnpm exec supabase functions deploy send-push-reminders --project-ref dedtyhomynsmvatfnshs --use-api --no-verify-jwt
   ```

4. Ejecuta el SQL local ignorado contra la ref explícita y elimínalo después. Crea en Vault `ordia_project_url` y `ordia_push_cron_secret` sin escribir sus valores en una migración.
5. Ejecuta `supabase/setup_push_cron.example.sql` contra Ordia. Habilita `pg_cron` y `pg_net` y crea `ordia-push-reminders-hourly` de forma idempotente.
6. Verifica el historial en **Integrations → Cron → Jobs**, los logs de `send-push-reminders` y la tabla de intentos sin exponer endpoints o claves.

Supabase inyecta sus claves de servidor en la Edge Function; no se copian al repositorio. Las dependencias de la función están fijadas a versiones exactas en su `deno.json`.

Al 27 de octubre de 2026, los pasos anteriores están aplicados en Ordia: cuatro secretos de función configurados, dos secretos de Vault presentes, Edge Function activa en versión 1, `pg_cron`/`pg_net` habilitados y un único job activo con expresión `0 * * * *`. El job solo construye la URL `/functions/v1/send-push-reminders` y envía el encabezado privado esperado. La función decide el horario mediante `America/Bogota`; fuera de 08:00–20:00 responde sin procesar recordatorios.

### Instalación y prueba en dispositivos

- Los service workers y Push API requieren HTTPS; `http://localhost` se acepta solo para desarrollo local.
- En iPhone/iPad con iOS/iPadOS 16.4 o posterior, abre Ordia en Safari, usa **Compartir → Añadir a pantalla de inicio**, abre el icono instalado y pulsa **Activar notificaciones**. La versión abierta como pestaña no debe solicitar permiso.
- En navegadores compatibles de computador o Android, inicia sesión y pulsa **Activar notificaciones**. Si el navegador deniega el permiso, debe rehabilitarse desde su configuración.
- El sistema operativo, modos de ahorro, Focus y el proveedor push pueden retrasar o suprimir una entrega. Ordia registra intentos, no una garantía de presentación.

La versión de prueba está disponible en **https://ordia-seven.vercel.app**. Para la primera prueba en iPhone:

1. Abre esa URL en Safari.
2. Usa **Compartir → Añadir a pantalla de inicio**.
3. Abre Ordia desde el icono instalado e inicia sesión.
4. Entra en **Gastos fijos**, pulsa **Activar notificaciones** y acepta el permiso de iOS.
5. Crea o conserva una obligación impaga con vencimiento hoy o anterior.
6. Entre 08:00 y 20:00 Bogotá, espera la siguiente hora en punto. El job se ejecuta una vez por hora. También puede hacerse una invocación autorizada puntual sin compartir secretos.

### Despliegue de prueba en Vercel

- Proyecto dedicado: `sargdev02-2791s-projects/ordia`.
- URL estable: `https://ordia-seven.vercel.app`.
- El primer despliegue se hizo desde el árbol local. El proyecto ahora está enlazado a `SargDev02/Ordia` en GitHub, con **master** como rama de producción. Un push normal a esa rama inicia el despliegue automático; se verifica el SHA en Vercel antes de darlo por publicado. No se ejecuta un despliegue manual adicional si el automático está en curso.
- `vercel.json` declara Vite, `dist`, el fallback de SPA a `index.html` y cabeceras sin caché prolongada para `sw.js` y `manifest.webmanifest`.
- Vercel contiene únicamente `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` y `VITE_VAPID_PUBLIC_KEY` en Preview y Production. No contiene claves privadas VAPID, `service_role` ni `PUSH_CRON_SECRET`.
- Supabase Auth usa esa URL como Site URL. Conserva como redirects exactos confirmación y recuperación tanto para `http://localhost:5173` como para el dominio HTTPS.
- Se comprobaron por HTTPS la raíz, acceso, gasto fijo, confirmación, recuperación, bundles, manifest y service worker. Las rutas directas devolvieron `200`; una visita anónima a `/gastos-fijos` terminó correctamente en `/iniciar-sesion`.

El manifest declara `display: standalone`, `start_url: /` y `scope: /`. `sw.js` se sirve desde la raíz con `Service-Worker-Allowed: /`, contiene el manejador Push y abre `/gastos-fijos`. Falta comprobar una sesión autenticada y una entrega real en el iPhone.

Referencias: [Supabase Scheduled Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions), [Supabase Edge Function secrets](https://supabase.com/docs/guides/functions/secrets), [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API) y [Web Push en iOS/iPadOS](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

## Aplicar la migración a Ordia

La migración no debe aplicarse a ningún proyecto distinto de Ordia. Autentica la CLI con la cuenta que tiene acceso al proyecto y verifica la ref antes de continuar:

```powershell
pnpm exec supabase login
pnpm exec supabase projects list
pnpm exec supabase link --project-ref dedtyhomynsmvatfnshs
pnpm exec supabase db push --dry-run
```

Comprueba que la salida identifique exclusivamente `dedtyhomynsmvatfnshs` y la migración esperada. Si una instalación nueva todavía la tiene pendiente, aplícala:

```powershell
pnpm exec supabase db push
```

Las migraciones crean las tablas, políticas RLS, funciones, triggers y privilegios mínimos. Las tablas financieras que necesitan sincronización se agregan a `supabase_realtime`; las tablas de Web Push no dependen de Realtime. No uses otro proyecto ni elijas un destino por nombre aproximado.

### Estado al cerrar la etapa 3

Las migraciones `20261026173736_create_financial_accounts_and_transactions.sql` y `20261026220000_add_financial_categories.sql` fueron aplicadas a **Ordia** (`dedtyhomynsmvatfnshs`) mediante la CLI oficial enlazada a esa ref. El historial remoto y local coinciden. La segunda migró los tres movimientos existentes a referencias estables de categoría: dos gastos y un ingreso quedaron asociados mediante `category_id`. No debe volver a ejecutarse ni editarse una migración ya aplicada.

Se verificaron remotamente tablas, columnas, constraints, índices, triggers, grants, políticas RLS, funciones `SECURITY INVOKER` y la publicación `supabase_realtime`. RLS está activo en cuentas, categorías y movimientos; `authenticated` solo tiene `SELECT`, `INSERT` y `UPDATE` donde corresponde, y `anon` no tiene privilegios sobre las tablas financieras. `supabase db lint` no encontró errores de esquema. También se comprobó que la columna de texto anterior ya no existe y que los tres movimientos migrados tienen una categoría estable.

En la etapa 3 la conexión efectiva fue la CLI enlazada explícitamente a `dedtyhomynsmvatfnshs`; los comandos remotos incluyeron esa ref y no se utilizó ninguna conexión asociada a Megamotos.

### Estado al cerrar la etapa 4A

Las migraciones `20261026230000_add_recurring_fixed_expenses.sql` y `20261026234754_fix_fixed_expense_function_lint.sql` fueron aplicadas a **Ordia** (`dedtyhomynsmvatfnshs`). La segunda conserva el mismo comportamiento y corrige las dos advertencias del lint de PostgreSQL sin modificar la migración ya aplicada. El historial local y remoto coincide y un dry-run posterior informa que la base está actualizada.

Se verificaron en la base real las tres tablas nuevas, claves foráneas, restricciones de forma y unicidad, triggers, funciones `SECURITY INVOKER`, `search_path` vacío, permisos y nueve políticas RLS. `authenticated` dispone de `SELECT`, `INSERT` y `UPDATE` donde lo necesitan las RPC; no tiene `DELETE`, `anon` no tiene privilegios y los triggers impiden usar escrituras directas para eludir el flujo. Las tres tablas están publicadas en `supabase_realtime`. `supabase db lint --linked --level warning` terminó sin hallazgos.

La verificación remota usó el enlace MCP **Personales** con `project_id` explícito `dedtyhomynsmvatfnshs`. Esa conexión también puede enumerar otro proyecto personal y, por tanto, no está limitada técnicamente a Ordia; todas las consultas se dirigieron explícitamente a Ordia. El enlace **Primary**, que solo expone Megamotos, se identificó y no se utilizó.

Como pgTAP no está instalado en el proyecto remoto, se ejecutaron pruebas SQL equivalentes dentro de una transacción con dos identidades `authenticated` normales y `ROLLBACK`. Comprobaron fin de mes, generación idempotente, intento de cuenta ajena sin escritura parcial, pago tardío, pago idempotente, vínculo y saldo, bloqueo de edición general, reversión lógica, pausa, reactivación sin cobros del intervalo, edición futura que conserva historia y aislamiento RLS. Todos los asserts pasaron y una consulta posterior confirmó que no quedaron usuarios ni datos de fixture.

El asesor de seguridad de Supabase mantiene una advertencia externa a esta etapa: **Leaked Password Protection** está desactivado en Auth y puede habilitarse desde el panel sin cambiar el esquema financiero. El asesor de rendimiento solo marcó índices como aún no usados, algo esperable en tablas recién creadas sin tráfico suficiente; no se eliminaron índices de claves foráneas ni de consultas previstas basándose en esa muestra inicial.

Las pruebas pgTAP locales no se ejecutaron porque Docker/PostgreSQL local no estaba activo. `fixed_expenses_test.sql` queda preparado para repetir localmente los flujos de recurrencia, pago, reversión, pausa, edición futura y aislamiento. La prueba real usó transacciones revertidas; Realtime entre dos navegadores y la experiencia visual todavía requieren la interacción manual descrita más abajo.

### Estado de la etapa 4B

Las migraciones `20261027001830_add_push_notifications.sql` y `20261027002318_harden_push_subscription_rpcs.sql` fueron aplicadas a **Ordia** (`dedtyhomynsmvatfnshs`). El historial local, el historial remoto consultado por MCP y la comparación de la CLI coinciden; un `db push --dry-run` posterior informó que no hay migraciones pendientes. La segunda migración mueve las operaciones privilegiadas de alta y baja a `private` y conserva en `public` envoltorios `SECURITY INVOKER`, sin editar la primera migración ya aplicada.

En la base real se verificaron las tablas `push_subscriptions` y `push_notification_attempts`, RLS activo, una política de propietario por tabla, privilegios de tabla mínimos y RPC separados entre cliente autenticado y servidor. Ambas tablas estaban vacías al finalizar. El asesor de seguridad solo conserva el aviso preexistente de **Leaked Password Protection** y `supabase db lint` terminó sin hallazgos.

La ejecución remota aislada conservada de esta etapa usó dos identidades `authenticated`, funciones del servidor y `ROLLBACK`. Comprobó registro por usuario, aislamiento de dispositivos, reserva idempotente de un intento, rechazo de una reserva simultánea, nueva comprobación después de pagar, pausa que impide el aviso futuro y reasignación segura de un endpoint compartido. La consulta de limpieza confirmó cero fixtures. La respuesta inválida `410` se simuló al completar el intento en PostgreSQL; no fue una respuesta real de un proveedor Web Push.

El 27 de octubre de 2026 se generó el par VAPID y el secreto de Cron directamente en archivos locales ignorados, se cargaron los cuatro secretos de la función en Ordia y se crearon los dos secretos de Vault. `send-push-reminders` está desplegada y activa en versión 1 con `verify_jwt = false`; una llamada sin `x-ordia-cron-secret` devolvió `401` y una llamada autorizada devolvió `200`. La prueba autorizada ocurrió fuera de la ventana horaria y respondió `outside_send_window`, por lo que no intentó enviar avisos.

`pg_cron` y `pg_net` están habilitados. Existe un único job activo `ordia-push-reminders-hourly`, con expresión `0 * * * *`, dirigido únicamente a `/functions/v1/send-push-reminders` y con la referencia al secreto de Vault. Aunque Cron usa una expresión horaria independiente de zona, la Edge Function calcula la fecha y hora en `America/Bogota` y solo procesa entre 08:00 y 20:00.

También se ejecutó una solicitud de verificación con la misma construcción Vault + `pg_net` usada por el job. Terminó con HTTP `200`, sin timeout ni error, y `outside_send_window`; esto comprueba el trayecto y la autenticación del job sin enviar una notificación fuera del horario.

La Edge Function no se sirvió localmente porque este entorno no tenía Docker/Deno disponibles, pero el despliegue compiló y ambas llamadas remotas comprobaron su arranque y protección. El frontend HTTPS está publicado en `https://ordia-seven.vercel.app`; permanecen pendientes una suscripción desde un navegador real, la respuesta efectiva de un proveedor Web Push —incluidos `404`/`410` reales— y la recepción/presentación en un dispositivo.

## Supabase local y prueba de base de datos

Con Docker Desktop activo:

```powershell
pnpm supabase:start
pnpm supabase:reset
pnpm supabase:test
```

Las pruebas pgTAP preparadas cubren saldo inicial cero, propiedad, idempotencia, transferencias inválidas, cuentas archivadas, ausencia de escritura parcial, categorías privadas y gastos fijos. `fixed_expenses_test.sql` añade fin de mes, febrero bisiesto, períodos omitidos sin duplicados, pagos y reversión, pausa y reactivación, cambios futuros e aislamiento. `push_notifications_test.sql` añade RLS, alta de dispositivos, bloqueo de escrituras directas, reserva concurrente, nueva comprobación antes de entregar, pausa/cancelación, aislamiento y desactivación de endpoints inválidos. Esta suite local no se ejecutó en esta etapa porque Docker Desktop/PostgreSQL local no estaba disponible; la prueba remota equivalente y revertida se describe arriba.

Para repetir la inspección remota no destructiva:

```powershell
pnpm exec supabase migration list --project-ref dedtyhomynsmvatfnshs
pnpm exec supabase db query --linked --project-ref dedtyhomynsmvatfnshs --file supabase/verify_financial_schema.sql
pnpm exec supabase db lint --linked --project-ref dedtyhomynsmvatfnshs --schema public --level warning --fail-on warning
```

## Verificaciones del frontend

```powershell
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

Las verificaciones del frontend cubren protección de rutas y cambios de sesión, acciones rápidas y diálogos, cálculos financieros, categorías, filtros de cuentas, reglas de recurrencia de fin de mes y año bisiesto, estados de obligación y los formularios adaptables de configuración, pago y pausa. También comprueban límites mensuales de Bogotá, vencimientos anteriores, de hoy y posteriores, cambio de diciembre a enero, pago tardío, pago anticipado y que al pagar el período actual no se presente automáticamente el siguiente mes. Las pruebas de Web Push comprueban fechas y horario de Bogotá, clasificación de víspera/vencimiento/vencido, ausencia de solicitud de permiso antes del gesto del usuario, guía de instalación en iPhone y estado no bloqueante si falta VAPID. Son pruebas unitarias o de interfaz con mocks; no prueban la entrega del proveedor.

Al cerrar la etapa 4B pasaron `typecheck`, `lint`, **49 pruebas de Vitest en 7 archivos**, `build` y `git diff --check`.

### Cierre de tareas y calendarios

- El usuario confirmó tareas/checklist y conexiones y consultas reales de iCloud y Google. La consulta de eventos permanece en modo de lectura.
- Se contrastaron todos los módulos locales con las funciones remotas: `icloud-calendar` y `google-calendar`, ambas **versión 5 ACTIVE**, coinciden. El cierre no vuelve a desplegarlas ni cambia secretos.
- Las trece migraciones coinciden en el proyecto **Ordia — `dedtyhomynsmvatfnshs`**. Se incluyen las migraciones de tareas, iCloud, Google, sugerencias de horarios (`20261028020000_add_task_scheduling_suggestions.sql`) y la serialización y protección contra conflictos de concurrencia (`20261028130644_serialize_task_scheduling_conflicts.sql`); no se vuelven a ejecutar ni se editan.
- La migración `20261028130644_serialize_task_scheduling_conflicts.sql` añade serialización a nivel de usuario con `pg_advisory_xact_lock`, trigger `validate_personal_task_schedule` contra solapamientos también en modificaciones manuales, y amplía la RPC `schedule_personal_task` para revalidar versión, duración, futuro, disponibilidad, márgenes, vencimiento vigente, otras tareas, eventos externos y cobertura/frescura. `p_accept_unverified_calendars` omite únicamente cobertura/frescura; los demás controles permanecen. La revisión puntual posterior confirmó estas reglas sin modificar la migración aplicada.
- La suite local actual contiene **177 pruebas en 24 archivos**, cubriendo cálculo de huecos, márgenes, límites de vencimiento, tareas vencidas como reprogramación tardía, cobertura, reloj de resumen en tiempo real, eventos en curso simultáneos no truncados (>5), diálogos de disponibilidad y rechazo/confirmación de calendarios no verificados. Las cuatro carreras reales entre conexiones SQL están descritas por separado y no se cuentan como pruebas Vitest.
- Esta entrega reúne sugerencias de horarios, protección contra conflictos, actualización temporal de «Eventos de hoy», pruebas y las dos migraciones del planificador ya aplicadas. La publicación se realiza mediante commit y push normal a `master`, seguido del despliegue automático existente de Vercel, sin despliegue manual paralelo. Antes del push se volvió a contrastar el SQL local con las 13 migraciones de Ordia (ignorando formato/comentarios), sin diferencias ni ejecución de migraciones.
- La publicación usa `origin=https://github.com/SargDev02/Ordia.git`, rama **master**, y la integración Git de Vercel ya enlazada. El frontend solo necesita las tres variables públicas existentes. Los valores de `.env*`, `.vercel`, `.temp`, credenciales de herramientas, dependencias, compilaciones y capturas temporales quedan fuera del commit.
- Las verificaciones HTTP y de navegador de la URL publicada se informan al terminar el despliegue. Una ruta que sirve `index.html` con `200` no demuestra por sí sola que React haya redirigido correctamente ni que OAuth haya concluido; esas comprobaciones se distinguen en la entrega.

Para probar esta publicación en iPhone:

1. Abre `https://ordia-seven.vercel.app` en Safari, recarga con conexión e inicia sesión. Si ya tenías instalada la PWA, ciérrala y vuelve a abrirla con conexión para cargar la versión nueva.
2. Usa **Compartir → Añadir a pantalla de inicio** si todavía no la instalaste. Desde el icono, comprueba navegación, creación/edición, completar/desmarcar una tarea y formularios sin desbordamientos con teclado abierto.
3. Abre **Calendario**, comprueba las selecciones y eventos de ambos proveedores y **Eventos de hoy**. Las conexiones existentes pertenecen al usuario y deberían recuperarse desde Supabase al iniciar sesión en otro dispositivo.
4. Para comprobar expresamente OAuth desde producción, inicia la conexión o reconexión Google desde `https://ordia-seven.vercel.app/calendario` en Safari, con un usuario de prueba autorizado. Completa el consentimiento y verifica que vuelva exactamente al mismo dominio y conserve la sesión de Ordia. Reconectar vuelve a pedir la selección de calendarios.
5. Confirma Día/Semana/detalle, todo el día y horas de Bogotá. Repite con dos sesiones y usuarios distintos para comprobar Realtime y privacidad; no compartas contraseñas, códigos ni tokens. La entrega Web Push sigue siendo una prueba independiente.
6. En **Tareas → Disponibilidad**, revisa franjas y margen; crea una tarea de prueba con duración, solicita sugerencias y acepta una. Comprueba su horario en Calendario y que un conflicto conserve un mensaje claro. Una tarea vencida debe indicar reprogramación tardía y mantener su vencimiento original.
7. En **Resumen → Eventos de hoy**, comprueba «En curso», el grupo de todo el día y los próximos. Al terminar un evento debe desaparecer del resumen en hasta 30 segundos; al volver del segundo plano debe actualizarse. El evento debe seguir disponible en Calendario. Esta comprobación autenticada en iPhone queda pendiente del dispositivo del usuario.

## Comprobación manual remota

Usa dos correos reales distintos y dos ventanas o perfiles del navegador. No compartas contraseñas, tokens ni claves en chats, capturas, logs o commits.

1. Registra y confirma a los usuarios A y B. Al cerrar esta etapa solo existía un usuario, así que debe crearse el segundo desde la aplicación.
2. Como A, crea `A principal` con saldo inicial `$1.000.000` y `A ahorro` con saldo inicial cero.
3. Registra en `A principal` un ingreso de `$200.000`, un gasto de `$50.000` y una transferencia de `$100.000` hacia `A ahorro`.
4. Verifica estos resultados: `A principal` `$1.050.000`, `A ahorro` `$100.000`, saldo total `$1.150.000`, ingresos `$200.000` y gastos `$50.000`. La transferencia no debe aparecer en los totales del mes.
5. Edita el gasto a `$75.000`; el saldo total debe quedar en `$1.125.000`. Elimínalo y confirma que el saldo vuelva a `$1.200.000` y los gastos del mes a cero.
6. Abre dos sesiones simultáneas de A. Crea o edita un movimiento desde una y confirma que la otra actualice movimientos, saldos y resumen sin recargar.
7. Para comprobar un fallo atómico, deja abierto un formulario de transferencia en la primera sesión y archiva la cuenta de destino desde la segunda. Al enviar el formulario antiguo, debe mostrarse un error y ninguno de los dos saldos debe cambiar.
8. Elimina una transferencia desde una sesión y confirma que en la otra desaparezca completa y ambos saldos se recalculen. Esto comprueba la eliminación lógica recibida como `UPDATE` de Realtime.
9. Desconecta y reconecta una sesión de A; confirma que recupere los datos completos, no solo eventos recibidos durante la conexión.
10. Inicia sesión como B y verifica cuentas, movimientos y resúmenes vacíos. Crea datos de B y confirma que ninguna sesión de A los reciba o pueda consultarlos.
11. Cierra A e inicia B en la misma ventana; verifica que la interfaz borre inmediatamente toda la información anterior.
12. Como A, crea una categoría principal y una subcategoría, registra un gasto con la subcategoría y comprueba que se presente como `Principal > Subcategoría`.
13. Renombra la categoría principal y confirma que el movimiento anterior muestre el nuevo nombre sin perder su asociación. Archívala y confirma que también se archive la subcategoría, que ambas desaparezcan de movimientos nuevos y que el movimiento histórico siga editable.
14. Prueba **Todas**, una cuenta, varias y **Limpiar**. Confirma que ninguna selección produzca saldo y lista vacíos; que las cuentas archivadas puedan seleccionarse; y que una transferencia aparezca una sola vez al seleccionar origen, destino o ambos.
15. Combina cuentas con tipo y fechas. Confirma que el saldo total siga siendo el saldo actual de las cuentas seleccionadas, mientras ingresos, gastos, agrupación y lista respetan el período y el tipo indicados.
16. Abre **Gastos fijos**, crea uno mensual con vencimiento el 31 y otro anual con fecha base 29 de febrero. Confirma los ajustes de fin de mes y que los pendientes no cambien el saldo ni los gastos del resumen.
17. Edita importe, categoría o cuenta desde una fecha futura. Confirma que pagos y vencimientos anteriores conserven sus datos y que el cambio aparezca únicamente desde la fecha efectiva.
18. Pausa un gasto con obligaciones vencidas y próximas: las vencidas deben seguir disponibles y las próximas desaparecer. Reactívalo indicando el siguiente vencimiento y confirma que el intervalo pausado no genere cobros.
19. Paga una obligación con un importe real distinto. Confirma que aparezca una sola vez como gasto en la cuenta y en los reportes; en movimientos debe figurar como **Gasto fijo** y no ofrecer edición o eliminación general.
20. Deshaz el pago desde **Gastos fijos**. Confirma que la obligación vuelva a pendiente, el movimiento deje de afectar el saldo y la otra sesión se actualice.
21. Con dos sesiones del mismo usuario, paga la misma obligación casi simultáneamente. Solo una operación debe quedar registrada. Luego confirma que el usuario B no reciba configuraciones, períodos ni movimientos de A.
22. Abre `https://ordia-seven.vercel.app` en Safari, añádela a la pantalla de inicio, inicia Ordia desde el icono, autentícate y pulsa **Activar notificaciones**. Comprueba que el permiso no se solicite antes de ese gesto y que el dispositivo aparezca en la lista.
23. Crea obligaciones de prueba para mañana, hoy y ayer y ejecuta una invocación autorizada dentro del horario documentado. Comprueba un aviso discreto por dispositivo, que al pulsarlo abra **Gastos fijos**, y que no revele nombre, importe ni identificadores en la pantalla bloqueada o la URL.
24. Paga, pausa o cancela una obligación antes de la invocación y confirma que no se envíe. Ejecuta dos invocaciones simultáneas y comprueba que la reserva única evite duplicar el intento.
25. Desactiva las notificaciones y luego cierra sesión en un dispositivo compartido. Confirma que el navegador cancele su suscripción y que la cuenta siguiente no reciba avisos de la anterior. La entrega real debe repetirse al menos en un iPhone/iPad instalado y en otro navegador compatible.

### Revisión visual pendiente

Si no hay una pestaña local con URL verificable y una sesión autorizada, comprueba manualmente:

- que las cuatro acciones rápidas estén inmediatamente debajo del resumen;
- que los diálogos de cuenta y movimiento sean centrados en computador y utilizables como panel desplazable en celular;
- que administración de categorías permita crear, renombrar y archivar principales y subcategorías sin desbordamientos;
- que el selector de cuentas se adapte a nombres largos y muestre con claridad **Todas** y ninguna selección;
- que las tarjetas expliquen el período y el alcance de cuentas de sus cifras.
- que la navegación **Resumen / Gastos fijos** sea clara y el resumen mensual de pendientes y vencidos esté separado de gastos realizados;
- que los formularios de gasto fijo y pago sean cómodos en celular, con controles grandes y desplazamiento interno;
- que las vistas **Pendientes del mes**, **Próximo mes**, **Vencidos** y **Pagados este mes** no desborden y expliquen sus límites de fecha;
- que pagar una obligación del mes la retire de la lista principal sin mostrar en su lugar un período del mes siguiente;
- que un pago anticipado figure como pagado al llegar su mes, y que un pago tardío se contabilice según su fecha real de pago;
- que pausar, reactivar, dar de baja y deshacer pago presenten confirmaciones y devuelvan el foco correctamente.
- que la tarjeta **Notificaciones de pagos** sea legible en celular y computador, muestre el estado correcto y que la guía de iPhone no desborde;
- que activar o desactivar conserve foco visible, mensajes comprensibles y controles táctiles cómodos.

La atomicidad y los intentos de referencia cruzada deben confirmarse además con pgTAP o un cliente autenticado con las claves públicas de A/B; no se debe usar `service_role` como prueba de RLS.

## Estructura

```text
src/
├── auth/        Contexto, eventos de sesión, rutas y pruebas
├── calendar/    Agenda unificada, fechas de Bogotá, caché y pruebas de iCloud/Google
├── components/  Formularios y diálogos accesibles
├── finance/     Estado, Realtime, cálculos, recurrencias y pruebas
├── notifications/ Política horaria de avisos y pruebas
├── tasks/       Estado privado, Realtime, fechas y filtros de tareas
├── pages/       Acceso, resumen, gastos fijos, tareas y calendario privados
├── services/    Cliente único de Supabase, finanzas, tareas, calendario y Web Push
└── types/       Tipos compartidos
supabase/
├── functions/   Edge Functions de pagos, iCloud y Google; CalDAV/iCalendar/OAuth
├── migrations/  Esquema versionado, RLS y Realtime
├── tests/       Pruebas pgTAP de integridad y aislamiento
├── checks/      Pruebas SQL transaccionales de tareas, iCloud y Google, separadas de pgTAP
├── setup_push_cron.example.sql  Plantilla versionada del job aplicado sin secretos
└── verify_financial_schema.sql  Inspección remota no destructiva
```

## Seguridad y alcance

- Supabase Auth administra contraseñas, sesiones y tokens; el frontend usa exclusivamente la clave pública.
- Las rutas protegidas son una medida de interfaz. La privacidad real de las tablas está en RLS y en las validaciones de propiedad de la base de datos.
- Las suscripciones Realtime se filtran por `user_id`, se liberan al cerrar o cambiar de sesión y vuelven a consultar el estado al conectar.
- El backend Web Push, sus secretos y Cron están configurados en Ordia. La entrega sigue sin comprobarse hasta registrar un dispositivo y recibir un aviso real. El usuario confirmó tareas/checklist y conexión/consulta real de iCloud y Google; esta etapa publica su frontend mediante GitHub y Vercel. Se mantienen pendientes OAuth iniciado desde el dominio publicado, la sesión en iPhone y las comprobaciones avanzadas entre usuarios/dispositivos descritas arriba. No se implementaron Notion, escritura en calendarios, sugerencias, recurrencia/notificaciones de tareas, conversión de monedas ni conexión bancaria.

El proyecto se desarrolla por etapas. No se debe comenzar la etapa siguiente hasta solicitarla expresamente.
