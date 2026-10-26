# Servicios

`supabase.ts` contiene la única instancia del cliente de Supabase para el navegador.

- Solo admite la URL y la clave publicable configuradas mediante variables `VITE_`.
- La URL remota debe corresponder al proyecto Ordia; también se admite Supabase local para pruebas.
- Rechaza claves `sb_secret_` y JWT con rol `service_role`.
- El SDK administra la persistencia y renovación de la sesión.
- `finance.ts` concentra las operaciones sobre cuentas y movimientos. Las escrituras críticas se validan y serializan en PostgreSQL.
- `FinanceContext` administra las suscripciones Realtime, su limpieza y la recarga completa al conectar.

No se han agregado clientes de calendarios, Web Push ni módulos fuera de la etapa financiera actual.
