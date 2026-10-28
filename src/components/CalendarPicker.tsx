import { useState } from 'react'
import type { IcloudCalendar } from '../types/calendar'
import { FormDialog } from './FormDialog'
import { AuthNotice } from './AuthNotice'

export function CalendarPicker({ calendars, onSave, onClose }: { calendars: IcloudCalendar[]; onSave: (ids: string[]) => Promise<void>; onClose: () => void }) {
  const [selected, setSelected] = useState(calendars.filter((calendar) => calendar.selected).map((calendar) => calendar.id))
  const [dirty, setDirty] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  function close() { if (!busy && (!dirty || window.confirm('¿Descartar la selección de calendarios sin guardar?'))) onClose() }
  return <FormDialog title="Elegir calendarios" onClose={close}><form className="p-6 sm:p-8" onSubmit={async (event) => {
    event.preventDefault(); if (busy) return
    if (selected.length > 15) return setError('Selecciona como máximo 15 calendarios.')
    setBusy(true); setError('')
    try { await onSave(selected); onClose() } catch (caught) { setError(caught instanceof Error ? caught.message : 'No pudimos guardar la selección.') } finally { setBusy(false) }
  }}><div className="flex items-start justify-between gap-3"><h2 className="text-2xl font-semibold text-[#173f31]">Elegir calendarios</h2><button className="min-h-11 px-2 font-semibold text-[#52675d]" data-dialog-initial-focus disabled={busy} onClick={close} type="button">Cerrar</button></div><p className="mt-3 text-sm leading-6 text-[#66796f]">Solo se copiarán eventos de los calendarios seleccionados. Puedes dejar todos sin seleccionar.</p><fieldset className="mt-5 grid gap-2" disabled={busy}><legend className="sr-only">Calendarios privados disponibles</legend>{calendars.map((calendar) => <label className="flex min-h-12 min-w-0 items-center gap-3 rounded-xl border border-[#d6e1d3] p-3" key={calendar.id}><input className="size-5 shrink-0 accent-[#315c49]" checked={selected.includes(calendar.id)} onChange={(event) => { setDirty(true); setSelected(event.target.checked ? [...selected, calendar.id] : selected.filter((id) => id !== calendar.id)) }} type="checkbox" /><span className="min-w-0 break-words text-sm text-[#264a3c]">{calendar.name}</span></label>)}</fieldset>{calendars.length === 0 && <p className="mt-5 text-sm text-[#718279]">No se descubrieron calendarios de eventos accesibles para esta cuenta.</p>}{error && <div className="mt-4"><AuthNotice tone="error">{error}</AuthNotice></div>}<div className="mt-6 flex justify-end"><button className="min-h-12 rounded-xl bg-[#173f31] px-5 font-semibold text-white disabled:opacity-60" disabled={busy} type="submit">{busy ? 'Guardando…' : 'Guardar selección'}</button></div></form></FormDialog>
}
