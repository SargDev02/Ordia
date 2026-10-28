import { useState, type FormEvent } from 'react'
import type { AvailabilitySlot, TaskSchedulingPreferences } from '../types/tasks'
import { DAY_OF_WEEK_LABELS, DEFAULT_AVAILABILITY_SLOTS, validateAvailabilitySlots } from '../tasks/scheduling'
import { AuthNotice } from './AuthNotice'
import { FormDialog } from './FormDialog'

interface AvailabilityDialogProps {
  userId: string
  preferences: TaskSchedulingPreferences | null
  onSave: (prefs: Omit<TaskSchedulingPreferences, 'created_at' | 'updated_at'>) => Promise<unknown>
  onClose: () => void
}

export function AvailabilityDialog({ userId, preferences, onSave, onClose }: AvailabilityDialogProps) {
  const [slots, setSlots] = useState<AvailabilitySlot[]>(
    preferences?.slots && preferences.slots.length > 0 ? preferences.slots : DEFAULT_AVAILABILITY_SLOTS,
  )
  const [bufferMinutes, setBufferMinutes] = useState(preferences?.buffer_minutes ?? 15)
  const [allDayBlocks, setAllDayBlocks] = useState(preferences?.all_day_blocks ?? true)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function close() {
    if (busy) return
    if (dirty && !window.confirm('Tienes cambios sin guardar. ¿Quieres descartarlos?')) return
    onClose()
  }

  function addSlot(day: number) {
    setDirty(true)
    setError('')
    // Buscar la última hora de fin existente para este día
    const daySlots = slots.filter((s) => s.day_of_week === day).sort((a, b) => a.end_time.localeCompare(b.end_time))
    let newStart = '14:00'
    let newEnd = '18:00'
    if (daySlots.length === 1 && daySlots[0].end_time <= '13:00') {
      newStart = '14:00'
      newEnd = '18:00'
    } else if (daySlots.length > 0) {
      const lastEnd = daySlots[daySlots.length - 1].end_time
      newStart = lastEnd < '20:00' ? lastEnd : '09:00'
      newEnd = lastEnd < '20:00' ? '21:00' : '12:00'
    }
    setSlots((prev) => [...prev, { day_of_week: day, start_time: newStart, end_time: newEnd }])
  }

  function updateSlot(index: number, field: 'start_time' | 'end_time', value: string) {
    setDirty(true)
    setError('')
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)))
  }

  function removeSlot(index: number) {
    setDirty(true)
    setError('')
    setSlots((prev) => prev.filter((_, i) => i !== index))
  }

  function applyPreset() {
    setDirty(true)
    setError('')
    setSlots(DEFAULT_AVAILABILITY_SLOTS)
  }

  function clearAll() {
    setDirty(true)
    setError('')
    setSlots([])
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (busy) return
    setError('')

    if (slots.length === 0) {
      return setError('Debes configurar al menos una franja horaria disponible para sugerir tareas.')
    }

    const validationError = validateAvailabilitySlots(slots)
    if (validationError) {
      return setError(validationError)
    }

    setBusy(true)
    try {
      await onSave({
        user_id: userId,
        buffer_minutes: bufferMinutes,
        all_day_blocks: allDayBlocks,
        slots,
      })
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos guardar tus preferencias.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormDialog onClose={close} title="Disponibilidad personal">
      <form aria-busy={busy} className="p-6 sm:p-8" onSubmit={submit}>
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold text-[#173f31]">Disponibilidad personal</h2>
            <p className="mt-1 text-sm text-[#66796f]">
              Zona horaria: <span className="font-semibold text-[#264a3c]">America/Bogota (UTC−5)</span>.
            </p>
          </div>
          <button
            className="min-h-11 px-2 text-sm font-semibold text-[#52675d]"
            disabled={busy}
            onClick={close}
            type="button"
          >
            Cerrar
          </button>
        </div>

        <p className="text-sm leading-6 text-[#52675d]">
          Define los días y franjas horarias en los que puedes trabajar en tareas. Las sugerencias automáticas solo
          se propondrán dentro de estos espacios.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="rounded-xl border border-[#d6e1d3] bg-[#f8faf6] px-3 py-1.5 text-xs font-semibold text-[#315c49]"
            disabled={busy}
            onClick={applyPreset}
            type="button"
          >
            Usar horario habitual (Lun–Vie 9–12 y 14–18)
          </button>
          <button
            className="rounded-xl border border-[#d6e1d3] bg-white px-3 py-1.5 text-xs font-semibold text-[#8b554d]"
            disabled={busy}
            onClick={clearAll}
            type="button"
          >
            Limpiar franjas
          </button>
        </div>

        <div className="mt-6 space-y-4">
          {[1, 2, 3, 4, 5, 6, 7].map((day) => {
            const daySlots = slots
              .map((slot, originalIndex) => ({ slot, originalIndex }))
              .filter(({ slot }) => slot.day_of_week === day)

            return (
              <div
                key={day}
                className="rounded-2xl border border-[#dce6d9] bg-white p-4"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-[#173f31]">
                    {DAY_OF_WEEK_LABELS[day]}
                  </span>
                  <button
                    className="text-xs font-semibold text-[#346a52] underline"
                    disabled={busy}
                    onClick={() => addSlot(day)}
                    type="button"
                  >
                    + Agregar franja
                  </button>
                </div>

                {daySlots.length === 0 ? (
                  <p className="mt-2 text-xs text-[#829188]">No disponible</p>
                ) : (
                  <div className="mt-3 space-y-2">
                    {daySlots.map(({ slot, originalIndex }, idx) => (
                      <div
                        key={originalIndex}
                        className="flex flex-wrap items-center gap-2 rounded-xl bg-[#f8faf6] p-2 text-sm"
                      >
                        <span className="text-xs text-[#66796f]">Franja {idx + 1}:</span>
                        <label className="sr-only" htmlFor={`slot-${originalIndex}-start`}>
                          Inicio {DAY_OF_WEEK_LABELS[day]} {idx + 1}
                        </label>
                        <input
                          aria-label={`Inicio ${DAY_OF_WEEK_LABELS[day]} ${idx + 1}`}
                          className="rounded-lg border border-[#d6e1d3] bg-white px-2 py-1 text-xs"
                          id={`slot-${originalIndex}-start`}
                          onChange={(e) => updateSlot(originalIndex, 'start_time', e.target.value)}
                          type="time"
                          value={slot.start_time}
                        />
                        <span className="text-xs text-[#66796f]">a</span>
                        <label className="sr-only" htmlFor={`slot-${originalIndex}-end`}>
                          Fin {DAY_OF_WEEK_LABELS[day]} {idx + 1}
                        </label>
                        <input
                          aria-label={`Fin ${DAY_OF_WEEK_LABELS[day]} ${idx + 1}`}
                          className="rounded-lg border border-[#d6e1d3] bg-white px-2 py-1 text-xs"
                          id={`slot-${originalIndex}-end`}
                          onChange={(e) => updateSlot(originalIndex, 'end_time', e.target.value)}
                          type="time"
                          value={slot.end_time}
                        />
                        <button
                          aria-label={`Eliminar franja ${idx + 1} de ${DAY_OF_WEEK_LABELS[day]}`}
                          className="ml-auto text-xs font-semibold text-[#8b554d]"
                          disabled={busy}
                          onClick={() => removeSlot(originalIndex)}
                          type="button"
                        >
                          Eliminar
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="mt-6 space-y-4 rounded-2xl border border-[#dce6d9] bg-[#f9fbf8] p-4">
          <div>
            <label className="block text-sm font-semibold text-[#173f31]" htmlFor="buffer-minutes">
              Margen de descanso entre compromisos
            </label>
            <p className="mt-1 text-xs text-[#66796f]">
              Tiempo libre que se deja antes y después de cada evento o tarea.
            </p>
            <select
              className="mt-2 min-h-11 rounded-xl border border-[#d6e1d3] bg-white px-3 text-sm text-[#173f31]"
              id="buffer-minutes"
              onChange={(e) => {
                setDirty(true)
                setBufferMinutes(Number(e.target.value))
              }}
              value={bufferMinutes}
            >
              <option value={0}>Sin margen (0 minutos)</option>
              <option value={5}>5 minutos</option>
              <option value={10}>10 minutos</option>
              <option value={15}>15 minutos (recomendado)</option>
              <option value={30}>30 minutos</option>
            </select>
          </div>

          <label className="flex items-start gap-3 text-sm text-[#264a3c]">
            <input
              checked={allDayBlocks}
              className="mt-1 size-4 rounded accent-[#315c49]"
              onChange={(e) => {
                setDirty(true)
                setAllDayBlocks(e.target.checked)
              }}
              type="checkbox"
            />
            <span>
              <span className="font-semibold">Eventos de todo el día bloquean la disponibilidad:</span>
              <span className="block text-xs text-[#66796f]">
                Si un día tiene un evento de todo el día (ej. feriado o viaje), no se sugerirán tareas en ese día.
              </span>
            </span>
          </label>
        </div>

        {error && (
          <div className="mt-5">
            <AuthNotice tone="error">{error}</AuthNotice>
          </div>
        )}

        <div className="mt-6 flex flex-wrap justify-end gap-3">
          <button
            className="min-h-11 rounded-xl border border-[#d6e1d3] bg-white px-4 text-sm font-semibold text-[#456356]"
            disabled={busy}
            onClick={close}
            type="button"
          >
            Cancelar
          </button>
          <button
            className="min-h-11 rounded-xl bg-[#173f31] px-5 text-sm font-semibold text-white disabled:opacity-60"
            disabled={busy}
            type="submit"
          >
            {busy ? 'Guardando…' : 'Guardar disponibilidad'}
          </button>
        </div>
      </form>
    </FormDialog>
  )
}
