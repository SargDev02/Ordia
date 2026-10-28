import { useMemo, useState } from 'react'
import type { CalendarEvent } from '../types/calendar'
import type { PersonalTask, TaskSchedulingPreferences } from '../types/tasks'
import {
  checkCalendarCoverage,
  generateTaskSuggestions,
  sortTasksForPlanning,
} from '../tasks/scheduling'
import { formatTaskInstant, TASK_PRIORITY_LABELS } from '../tasks/calculations'
import { AuthNotice } from './AuthNotice'

interface TaskPlanningSectionProps {
  tasks: PersonalTask[]
  preferences: TaskSchedulingPreferences | null
  today: string
  calendarEvents: CalendarEvent[]
  icloudInfo: {
    connected: boolean
    hasSelected: boolean
    error: string | null
    syncedAt: string | null
    ready?: boolean
  }
  googleInfo: {
    connected: boolean
    hasSelected: boolean
    error: string | null
    syncedAt: string | null
    ready?: boolean
  }
  onOpenAvailability: () => void
  onScheduleTask: (
    taskId: string,
    scheduledAt: string,
    expectedUpdatedAt: string,
    estimatedMinutes?: number | null,
    acceptUnverifiedCalendars?: boolean,
  ) => Promise<void>
  onRefreshCalendars?: () => Promise<void>
  isRefreshingCalendars?: boolean
}

export function TaskPlanningSection({
  tasks,
  preferences,
  today,
  calendarEvents,
  icloudInfo,
  googleInfo,
  onOpenAvailability,
  onScheduleTask,
  onRefreshCalendars,
  isRefreshingCalendars,
}: TaskPlanningSectionProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [durationInputs, setDurationInputs] = useState<Record<string, string>>({})
  const [busyScheduling, setBusyScheduling] = useState(false)
  const [actionError, setActionError] = useState('')
  const [unverifiedProposal, setUnverifiedProposal] = useState<string | null>(null)

  const unscheduledTasks = useMemo(() => {
    return sortTasksForPlanning(tasks, today)
  }, [tasks, today])

  const scheduledPendingTasks = useMemo(() => {
    return tasks.filter((t) => !t.deleted_at && !t.is_completed && t.scheduled_at)
  }, [tasks])

  // Advertir sobre tareas programadas que carecen de duración estimada
  const tasksWithoutDuration = useMemo(() => {
    return scheduledPendingTasks.filter((t) => !t.estimated_minutes || t.estimated_minutes <= 0)
  }, [scheduledPendingTasks])

  // Cobertura y frescura de los calendarios
  const coverage = useMemo(() => {
    return checkCalendarCoverage(
      today,
      {
        connected: icloudInfo.connected,
        hasSelected: icloudInfo.hasSelected,
        error: icloudInfo.error,
        syncedAt: icloudInfo.syncedAt,
        windowCovered: true,
      },
      {
        connected: googleInfo.connected,
        hasSelected: googleInfo.hasSelected,
        error: googleInfo.error,
        syncedAt: googleInfo.syncedAt,
        windowCovered: true,
      },
    )
  }, [today, icloudInfo, googleInfo])

  const selectedTask = unscheduledTasks.find((t) => t.id === selectedTaskId) ?? null

  const taskDuration = selectedTask
    ? (durationInputs[selectedTask.id]
      ? Number(durationInputs[selectedTask.id])
      : selectedTask.estimated_minutes ?? null)
    : null

  // Calcular sugerencias para la tarea seleccionada en tiempo real
  const suggestionResult = useMemo(() => {
    if (!selectedTask) return null
    const taskWithEffectiveDuration: PersonalTask = {
      ...selectedTask,
      estimated_minutes: taskDuration,
    }
    return generateTaskSuggestions({
      task: taskWithEffectiveDuration,
      preferences,
      externalEvents: calendarEvents,
      scheduledTasks: scheduledPendingTasks,
      today,
    })
  }, [selectedTask, taskDuration, preferences, calendarEvents, scheduledPendingTasks, today])

  async function handleSchedule(proposalStartAt: string, acceptUnverified = false) {
    if (!selectedTask || busyScheduling) return
    setBusyScheduling(true)
    setActionError('')
    if (!acceptUnverified) {
      setUnverifiedProposal(null)
    }
    try {
      await onScheduleTask(
        selectedTask.id,
        proposalStartAt,
        selectedTask.updated_at,
        taskDuration ?? selectedTask.estimated_minutes,
        acceptUnverified,
      )
      setSelectedTaskId(null)
      setUnverifiedProposal(null)
    } catch (caught) {
      const msg = caught instanceof Error ? caught.message : 'No pudimos programar la tarea.'
      setActionError(msg)
      if (msg.includes('No se pudo verificar la disponibilidad completa')) {
        setUnverifiedProposal(proposalStartAt)
      } else {
        setUnverifiedProposal(null)
      }
    } finally {
      setBusyScheduling(false)
    }
  }

  const hasAvailability = preferences && preferences.slots.length > 0

  return (
    <section
      aria-labelledby="planning-section-title"
      className="rounded-[24px] border border-[#dce6d9] bg-white p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-[#173f31]" id="planning-section-title">
            Tareas por organizar
          </h2>
          <p className="mt-1 text-sm text-[#66796f]">
            Sugerencias deterministas de horarios según tu disponibilidad en America/Bogota y compromisos de agenda.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="min-h-11 rounded-xl border border-[#d6e1d3] bg-[#f8faf6] px-4 py-2 text-sm font-semibold text-[#315c49]"
            onClick={onOpenAvailability}
            type="button"
          >
            {hasAvailability ? 'Ajustar disponibilidad' : 'Configurar disponibilidad'}
          </button>
          {onRefreshCalendars && coverage.hasSelectedCalendars && (
            <button
              className="min-h-11 rounded-xl border border-[#d6e1d3] bg-white px-4 py-2 text-sm font-semibold text-[#315c49] disabled:opacity-50"
              disabled={isRefreshingCalendars}
              onClick={() => void onRefreshCalendars()}
              type="button"
            >
              {isRefreshingCalendars ? 'Actualizando…' : 'Actualizar calendarios'}
            </button>
          )}
        </div>
      </div>

      {/* Estado de calendarios y sincronización */}
      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#718279]">
        <span>
          {coverage.hasSelectedCalendars
            ? `Última sincronización externa: ${coverage.lastSyncedAt ? formatTaskInstant(coverage.lastSyncedAt) : 'sin copia'}.`
            : 'Sin calendarios externos seleccionados (sugerencias basadas solo en disponibilidad personal).'}
        </span>
        <span className="text-[#829188]">
          La disponibilidad externa puede variar después de sincronizar; no se escribe en calendarios ajenos.
        </span>
      </div>

      {coverage.warning && (
        <div className="mt-3">
          <AuthNotice tone={coverage.staleOrError ? 'error' : 'info'}>
            {coverage.warning}
          </AuthNotice>
        </div>
      )}

      {tasksWithoutDuration.length > 0 && (
        <div className="mt-3">
          <AuthNotice tone="info">
            {`Hay ${tasksWithoutDuration.length} tarea${tasksWithoutDuration.length === 1 ? '' : 's'} programada${tasksWithoutDuration.length === 1 ? '' : 's'} sin duración estimada (${tasksWithoutDuration.map((t) => t.title).join(', ')}). Se reserva un margen preventivo para no considerarlo espacio libre.`}
          </AuthNotice>
        </div>
      )}

      {actionError && (
        <div className="mt-3 space-y-2">
          <AuthNotice tone="error">{actionError}</AuthNotice>
          {unverifiedProposal && (
            <div className="flex items-center gap-2">
              <button
                className="rounded-xl border border-[#d6e1d3] bg-[#f8faf6] px-3 py-1.5 text-xs font-semibold text-[#264a3c] hover:bg-[#edf3ea] disabled:opacity-60"
                disabled={busyScheduling}
                onClick={() => void handleSchedule(unverifiedProposal, true)}
                type="button"
              >
                Programar de todos modos sin validar calendarios externos
              </button>
            </div>
          )}
        </div>
      )}

      {!hasAvailability ? (
        <div className="mt-6 rounded-2xl border border-dashed border-[#c6d7c3] bg-[#f8faf6] p-6 text-center">
          <p className="font-semibold text-[#264a3c]">Aún no has configurado tu disponibilidad</p>
          <p className="mt-2 text-sm text-[#66796f]">
            Indica los días y franjas horarias en los que puedes trabajar para recibir propuestas de horario adaptadas a tu rutina.
          </p>
          <button
            className="mt-4 min-h-11 rounded-xl bg-[#173f31] px-5 py-2.5 text-sm font-semibold text-white"
            onClick={onOpenAvailability}
            type="button"
          >
            Configurar disponibilidad ahora
          </button>
        </div>
      ) : unscheduledTasks.length === 0 ? (
        <p className="mt-6 py-6 text-center text-sm text-[#718279]">
          No tienes tareas pendientes sin programar. ¡Todo tu trabajo pendiente está al día!
        </p>
      ) : (
        <div className="mt-6 divide-y divide-[#e5ebe2]">
          {unscheduledTasks.map((task) => {
            const isSelected = selectedTask?.id === task.id
            const currentDurationInput = durationInputs[task.id] ?? (task.estimated_minutes ? String(task.estimated_minutes) : '')

            return (
              <article className="py-4" key={task.id}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-words font-semibold text-[#264a3c]">{task.title}</span>
                      <span className="rounded-full bg-[#edf3ea] px-2 py-0.5 text-[11px] font-semibold text-[#4f8068]">
                        Prioridad {TASK_PRIORITY_LABELS[task.priority].toLowerCase()}
                      </span>
                      {task.due_on && (
                        <span className={`text-xs ${task.due_on < today ? 'font-semibold text-[#9a493e]' : 'text-[#66796f]'}`}>
                          {task.due_on < today ? `Venció: ${task.due_on}` : `Vence: ${task.due_on}`}
                        </span>
                      )}
                    </div>
                    {task.description && (
                      <p className="mt-1 line-clamp-1 text-xs text-[#718279]">{task.description}</p>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {/* Duración estimada */}
                    <div className="flex items-center gap-1.5 text-xs text-[#52675d]">
                      <label htmlFor={`duration-${task.id}`} className="sr-only">
                        Duración en minutos para {task.title}
                      </label>
                      <input
                        className="w-16 rounded-lg border border-[#d6e1d3] px-2 py-1 text-center text-xs"
                        id={`duration-${task.id}`}
                        min={1}
                        max={1000}
                        onChange={(e) => {
                          setDurationInputs((prev) => ({ ...prev, [task.id]: e.target.value }))
                        }}
                        placeholder="min"
                        type="number"
                        value={currentDurationInput}
                      />
                      <span>min</span>
                    </div>

                    <button
                      className={`min-h-10 rounded-xl px-3.5 py-1.5 text-xs font-semibold ${isSelected ? 'bg-[#edf3ea] text-[#264a3c]' : 'bg-[#173f31] text-white'}`}
                      onClick={() => {
                        setSelectedTaskId(isSelected ? null : task.id)
                        setActionError('')
                        setUnverifiedProposal(null)
                      }}
                      type="button"
                    >
                      {isSelected ? 'Ocultar sugerencias' : 'Sugerir horario'}
                    </button>
                  </div>
                </div>

                {/* Alternativas sugeridas */}
                {isSelected && suggestionResult && (
                  <div className="mt-4 rounded-2xl border border-[#dce6d9] bg-[#f8faf6] p-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-[#4f8068]">
                      Alternativas sugeridas para «{task.title}»
                    </h3>

                    {suggestionResult.error === 'missing_duration' ? (
                      <p className="mt-2 text-xs text-[#8b554d]">
                        Indica una duración estimada en minutos arriba para buscar espacios libres en tu agenda.
                      </p>
                    ) : suggestionResult.proposals.length === 0 ? (
                      <p className="mt-2 text-xs text-[#66796f]">
                        {suggestionResult.explanation}
                      </p>
                    ) : (
                      <div className="mt-3 space-y-2">
                        {suggestionResult.proposals.map((proposal, idx) => (
                          <div
                            key={proposal.start_at}
                            className="flex flex-col gap-2 rounded-xl border border-[#e1ece0] bg-white p-3 sm:flex-row sm:items-center sm:justify-between"
                          >
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-[#173f31]">
                                Opción {idx + 1}: {formatTaskInstant(proposal.start_at)}
                              </p>
                              <p className="mt-0.5 text-xs text-[#66796f]">
                                {proposal.explanation}
                              </p>
                            </div>

                            <button
                              className="shrink-0 rounded-xl bg-[#264a3c] px-4 py-2 text-xs font-semibold text-white disabled:opacity-60"
                              disabled={busyScheduling}
                              onClick={() => void handleSchedule(proposal.start_at)}
                              type="button"
                            >
                              {busyScheduling ? 'Programando…' : 'Programar en este horario'}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}
    </section>
  )
}
