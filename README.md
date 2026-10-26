# Ordia

**Tu tiempo y tu dinero, en orden.**

Aplicación web personal y adaptable para organizar tiempo y finanzas. La etapa 3 incorpora cuentas financieras, ingresos, gastos, transferencias, resúmenes y sincronización preparada con Supabase Realtime, manteniendo fuera de alcance los demás módulos.

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

Las migraciones crean las tablas, políticas RLS, funciones, triggers, privilegios mínimos y agregan cuentas, categorías y movimientos a la publicación `supabase_realtime`. No uses otro proyecto ni elijas un destino por nombre aproximado.

### Estado al cerrar la etapa 3

Las migraciones `20261026173736_create_financial_accounts_and_transactions.sql` y `20261026220000_add_financial_categories.sql` fueron aplicadas a **Ordia** (`dedtyhomynsmvatfnshs`) mediante la CLI oficial enlazada a esa ref. El historial remoto y local coinciden. La segunda migró los tres movimientos existentes a referencias estables de categoría: dos gastos y un ingreso quedaron asociados mediante `category_id`. No debe volver a ejecutarse ni editarse una migración ya aplicada.

Se verificaron remotamente tablas, columnas, constraints, índices, triggers, grants, políticas RLS, funciones `SECURITY INVOKER` y la publicación `supabase_realtime`. RLS está activo en cuentas, categorías y movimientos; `authenticated` solo tiene `SELECT`, `INSERT` y `UPDATE` donde corresponde, y `anon` no tiene privilegios sobre las tablas financieras. `supabase db lint` no encontró errores de esquema. También se comprobó que la columna de texto anterior ya no existe y que los tres movimientos migrados tienen una categoría estable.

La conexión MCP del plugin visible en la sesión seguía vinculada a Megamotos y no se utilizó. La conexión efectiva para Ordia fue la CLI: su cuenta puede enumerar otros proyectos, pero esta carpeta está enlazada explícitamente a `dedtyhomynsmvatfnshs` y cada comando remoto incluyó esa ref.

Las pruebas pgTAP locales no se ejecutaron porque Docker/PostgreSQL local no estaba activo. Las comprobaciones con dos sesiones normales, el flujo completo de categorías y Realtime todavía requieren la interacción manual descrita más abajo; no se crearon usuarios ni datos remotos artificiales.

## Supabase local y prueba de base de datos

Con Docker Desktop activo:

```powershell
pnpm supabase:start
pnpm supabase:reset
pnpm supabase:test
```

Las pruebas pgTAP preparadas cubren saldo inicial cero, propiedad, idempotencia, transferencias inválidas, cuentas archivadas, ausencia de escritura parcial y la jerarquía privada de categorías. `financial_categories_test.sql` comprueba dos niveles, tipos coherentes, unicidad, renombrado estable, archivado en cascada y aislamiento. La comprobación final de RLS debe hacerse además con dos sesiones Auth normales; no debe usarse `service_role` para afirmar aislamiento de usuario.

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

Al cerrar esta etapa pasaron `typecheck`, `lint`, 20 pruebas de Vitest y `build`. Las pruebas cubren protección de rutas y cambios de sesión, acciones rápidas y diálogos, cálculo de saldos, transferencias simétricas excluidas de reportes, edición/eliminación, límites mensuales de Bogotá, categorías estables y jerárquicas, agrupación por categoría principal y selección de todas, varias, una o ninguna cuenta.

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

### Revisión visual pendiente

Si no hay una pestaña local con URL verificable y una sesión autorizada, comprueba manualmente:

- que las cuatro acciones rápidas estén inmediatamente debajo del resumen;
- que los diálogos de cuenta y movimiento sean centrados en computador y utilizables como panel desplazable en celular;
- que administración de categorías permita crear, renombrar y archivar principales y subcategorías sin desbordamientos;
- que el selector de cuentas se adapte a nombres largos y muestre con claridad **Todas** y ninguna selección;
- que las tarjetas expliquen el período y el alcance de cuentas de sus cifras.

La atomicidad y los intentos de referencia cruzada deben confirmarse además con pgTAP o un cliente autenticado con las claves públicas de A/B; no se debe usar `service_role` como prueba de RLS.

## Estructura

```text
src/
├── auth/        Contexto, eventos de sesión, rutas y pruebas
├── components/  Formularios y diálogos accesibles
├── finance/     Estado, Realtime, cálculos, constantes y pruebas
├── pages/       Acceso, recuperación e inicio financiero privado
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
- No se implementaron gastos fijos, recordatorios push, calendarios, tareas, sugerencias, conversión de monedas, conexión bancaria ni publicación.

El proyecto se desarrolla por etapas. No se debe comenzar la etapa siguiente hasta solicitarla expresamente.
