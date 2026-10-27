# Ordia

**Tu tiempo y tu dinero, en orden.**

Aplicación web personal y adaptable para organizar tiempo y finanzas. La etapa 4A incorpora gastos fijos mensuales o anuales, obligaciones por período y registro atómico de pagos sobre la base financiera existente. Las notificaciones siguen fuera de alcance.

## Tecnologías

- React 19, TypeScript y Vite
- pnpm y Tailwind CSS 4
- React Router
- Supabase Auth, Database y Realtime con `@supabase/supabase-js`
- Supabase CLI y migraciones SQL versionadas
- Vitest, Testing Library y pgTAP
- Manifest web básico como preparación para una futura PWA

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
```

La clave publicable se obtiene en **Supabase Dashboard → Project Settings → API Keys** o en el diálogo **Connect**. Nunca uses una clave `sb_secret_`, `service_role` ni otro secreto del servidor en una variable `VITE_`.

Inicia la aplicación:

```powershell
pnpm dev
```

Abre `http://localhost:5173`. Vite usa el puerto fijo `5173` para que los enlaces de autenticación no cambien de destino.

## Configuración de Supabase Auth

En el proyecto Ordia (`dedtyhomynsmvatfnshs`):

1. En **Authentication → Providers → Email**, habilita correo y contraseña y conserva activa la confirmación de correo.
2. En **Authentication → URL Configuration**, usa `http://localhost:5173` como **Site URL**.
3. Agrega estas **Redirect URLs**:

   ```text
   http://localhost:5173/auth/confirm
   http://localhost:5173/restablecer-contrasena
   ```

## Modelo financiero

El modelo se construye con estas migraciones versionadas:

- `supabase/migrations/20261026173736_create_financial_accounts_and_transactions.sql`
- `supabase/migrations/20261026220000_add_financial_categories.sql`
- `supabase/migrations/20261026230000_add_recurring_fixed_expenses.sql`
- `supabase/migrations/20261026234754_fix_fixed_expense_function_lint.sql`

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

Las migraciones crean las tablas, políticas RLS, funciones, triggers, privilegios mínimos y agregan cuentas, categorías, movimientos y gastos fijos a la publicación `supabase_realtime`. No uses otro proyecto ni elijas un destino por nombre aproximado.

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

## Supabase local y prueba de base de datos

Con Docker Desktop activo:

```powershell
pnpm supabase:start
pnpm supabase:reset
pnpm supabase:test
```

Las pruebas pgTAP preparadas cubren saldo inicial cero, propiedad, idempotencia, transferencias inválidas, cuentas archivadas, ausencia de escritura parcial, categorías privadas y gastos fijos. `fixed_expenses_test.sql` añade fin de mes, febrero bisiesto, períodos omitidos sin duplicados, pagos y reversión, pausa y reactivación, cambios futuros e aislamiento. La comprobación final de RLS y Realtime debe hacerse además con dos sesiones Auth normales; no debe usarse `service_role` para afirmar aislamiento de usuario.

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

Las verificaciones del frontend cubren protección de rutas y cambios de sesión, acciones rápidas y diálogos, cálculos financieros, categorías, filtros de cuentas, reglas de recurrencia de fin de mes y año bisiesto, estados de obligación y los formularios adaptables de configuración, pago y pausa. También comprueban límites mensuales de Bogotá, vencimientos anteriores, de hoy y posteriores, cambio de diciembre a enero, pago tardío, pago anticipado y que al pagar el período actual no se presente automáticamente el siguiente mes. Son pruebas unitarias o de interfaz con mocks; las comprobaciones transaccionales reales se describen en el estado de la etapa 4A.

En el ajuste mensual de la vista pasaron `typecheck`, `lint`, 42 pruebas de Vitest y `build`.

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

La atomicidad y los intentos de referencia cruzada deben confirmarse además con pgTAP o un cliente autenticado con las claves públicas de A/B; no se debe usar `service_role` como prueba de RLS.

## Estructura

```text
src/
├── auth/        Contexto, eventos de sesión, rutas y pruebas
├── components/  Formularios y diálogos accesibles
├── finance/     Estado, Realtime, cálculos, recurrencias y pruebas
├── pages/       Acceso, resumen financiero y gastos fijos privados
├── services/    Cliente único de Supabase y acceso financiero
└── types/       Tipos compartidos
supabase/
├── migrations/  Esquema versionado, RLS y Realtime
├── tests/       Pruebas pgTAP de integridad y aislamiento
└── verify_financial_schema.sql  Inspección remota no destructiva
```

## Seguridad y alcance

- Supabase Auth administra contraseñas, sesiones y tokens; el frontend usa exclusivamente la clave pública.
- Las rutas protegidas son una medida de interfaz. La privacidad real de las tablas está en RLS y en las validaciones de propiedad de la base de datos.
- Las suscripciones Realtime se filtran por `user_id`, se liberan al cerrar o cambiar de sesión y vuelven a consultar el estado al conectar.
- Se implementaron gastos fijos y registro de pagos, pero no Web Push ni envío de recordatorios. Tampoco se implementaron calendarios, tareas, sugerencias, conversión de monedas, conexión bancaria ni publicación.

El proyecto se desarrolla por etapas. No se debe comenzar la etapa siguiente hasta solicitarla expresamente.
