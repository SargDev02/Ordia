import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { normalizeCategorySearch } from '../finance/calculations'
import type { FinancialCategory } from '../types/finance'

export interface CategoryPickerLeadingOption {
  id: string
  label: string
  search?: string
}

interface CategoryPickerProps {
  id: string
  categories: FinancialCategory[]
  options: FinancialCategory[]
  value: string
  disabled?: boolean
  label?: string
  placeholder?: string
  searchLabel?: string
  clearLabel?: string | null
  leadingOptions?: CategoryPickerLeadingOption[]
  formatOptionLabel?: (category: FinancialCategory, path: string) => string
  onChange: (id: string) => void
}

const normalizeSearch = normalizeCategorySearch

export function CategoryPicker({
  id,
  categories,
  options,
  value,
  disabled = false,
  label = 'Categoría',
  placeholder = 'Selecciona una categoría',
  searchLabel = 'Buscar categoría o subcategoría',
  clearLabel = 'Limpiar selección',
  leadingOptions = [],
  formatOptionLabel,
  onChange,
}: CategoryPickerProps) {
  const uid = useId()
  const listId = `${uid}-options`
  const hintId = `${uid}-hint`
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [isOpen, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)
  const expanded = isOpen && !disabled

  const choices = useMemo(() => {
    const byId = new Map(categories.map((category) => [category.id, category]))
    const leadingChoices = leadingOptions.map((option) => ({
      id: option.id,
      label: option.label,
      search: normalizeSearch(`${option.label} ${option.search ?? ''}`),
    }))
    const categoryChoices = options.map((category) => {
      const parent = category.parent_id ? byId.get(category.parent_id) : null
      const path = parent ? `${parent.name} → ${category.name}` : category.name
      const baseLabel = formatOptionLabel
        ? formatOptionLabel(category, path)
        : `${path}${category.archived_at ? ' (archivada)' : ''}`
      return {
        id: category.id,
        label: baseLabel,
        search: normalizeSearch(`${path} ${baseLabel}`),
      }
    })
    return [...leadingChoices, ...categoryChoices]
  }, [categories, formatOptionLabel, leadingOptions, options])

  const terms = normalizeSearch(query).split(' ').filter(Boolean)
  const filtered = choices.filter((choice) => terms.every((term) => choice.search.includes(term)))
  const active = (activeId !== null ? filtered.find((choice) => choice.id === activeId) : undefined) ?? filtered[0]
  const activeIndex = active ? filtered.indexOf(active) : -1
  const selected = choices.find((choice) => choice.id === value)

  function open(last = false) {
    setQuery('')
    setActiveId(last ? (choices.at(-1)?.id ?? null) : value)
    setOpen(true)
  }

  function close() {
    setOpen(false)
    triggerRef.current?.focus()
  }

  function select(nextId: string) {
    onChange(nextId)
    close()
  }

  useLayoutEffect(() => {
    if (!expanded) return
    // Enfoque sincrónico en la fase de commit para solicitar el teclado inmediatamente en iOS/Android.
    inputRef.current?.focus()
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    const viewport = window.visualViewport
    function fitResults() {
      const height = viewport?.height ?? window.innerHeight
      rootRef.current?.style.setProperty('--category-results-height', `${Math.max(80, Math.min(256, height * 0.35))}px`)
      if (document.activeElement === inputRef.current) {
        inputRef.current?.scrollIntoView?.({ block: window.innerWidth < 640 ? 'start' : 'nearest' })
      }
    }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    fitResults()
    viewport?.addEventListener('resize', fitResults)
    document.addEventListener('pointerdown', outside)
    return () => {
      viewport?.removeEventListener('resize', fitResults)
      document.removeEventListener('pointerdown', outside)
    }
  }, [expanded])

  useEffect(() => {
    const list = listRef.current
    const option = list?.querySelector<HTMLElement>('[data-active="true"]')
    if (!expanded || !list || !option) return
    const bounds = list.getBoundingClientRect()
    const optionBounds = option.getBoundingClientRect()
    // Desplazar solo los resultados, sin sacar el buscador del área visible del diálogo.
    if (optionBounds.top < bounds.top) list.scrollTop -= bounds.top - optionBounds.top
    else if (optionBounds.bottom > bounds.bottom) list.scrollTop += optionBounds.bottom - bounds.bottom
  }, [expanded, active?.id])

  return (
    <div
      className="min-w-0"
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onKeyDown={(event) => {
        if (expanded && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          close()
        }
      }}
      ref={rootRef}
    >
      <label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor={id}>{label}</label>
      <button
        aria-controls={expanded ? listId : undefined}
        aria-describedby={`${uid}-selection`}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        className="flex min-h-12 w-full min-w-0 items-center gap-3 rounded-2xl border border-[#d6e1d3] bg-white px-4 py-3.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315c49] disabled:opacity-60"
        disabled={disabled}
        id={id}
        onClick={() => (expanded ? close() : open())}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            open(event.key === 'ArrowUp')
          }
        }}
        ref={triggerRef}
        type="button"
      >
        <span className="min-w-0 flex-1 whitespace-normal [overflow-wrap:anywhere]" id={`${uid}-selection`}>
          {selected?.label ?? (value ? 'Categoría no disponible. Selecciona otra.' : placeholder)}
        </span>
        <span aria-hidden="true" className="shrink-0 text-[#66796f]">{expanded ? '▴' : '▾'}</span>
      </button>
      {expanded && (
        <div className="mt-2 min-w-0 rounded-2xl border border-[#c6d7c3] bg-[#f8faf6] p-3">
          <label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor={`${uid}-search`}>{searchLabel}</label>
          <input
            aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-describedby={hintId}
            aria-expanded="true"
            autoComplete="off"
            className="min-h-12 w-full min-w-0 scroll-mt-12 rounded-xl border border-[#c6d7c3] bg-white px-3 py-3 text-base focus-visible:outline-2 focus-visible:outline-[#315c49]"
            enterKeyHint="done"
            id={`${uid}-search`}
            onChange={(event) => {
              event.stopPropagation() // Buscar no altera el formulario ni su confirmación de descarte.
              setQuery(event.target.value)
              setActiveId(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                if (!event.nativeEvent.isComposing && active) select(active.id)
              } else if (!event.nativeEvent.isComposing && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
                event.preventDefault()
                if (filtered.length === 0) return
                const next = event.key === 'ArrowDown' ? activeIndex + 1 : activeIndex - 1
                const target = filtered[(next + filtered.length) % filtered.length]
                setActiveId(target ? target.id : null)
              }
            }}
            placeholder="Escribe para buscar…"
            ref={inputRef}
            role="combobox"
            type="text"
            value={query}
          />
          <p className="sr-only" id={hintId}>Usa las flechas arriba y abajo y Enter para elegir. Escape cierra el selector.</p>
          <ul
            aria-label="Categorías disponibles"
            className="mt-2 max-h-[min(16rem,35dvh)] overflow-y-auto overscroll-contain rounded-xl bg-white"
            id={listId}
            ref={listRef}
            role="listbox"
            style={{ maxHeight: 'var(--category-results-height, min(16rem,35dvh))' }}
          >
            {filtered.map((choice, index) => (
              <li
                aria-selected={choice.id === value}
                className={`flex min-h-12 cursor-pointer items-center gap-2 px-3 py-3 text-sm [overflow-wrap:anywhere] ${choice.id === active?.id ? 'bg-[#e3eddf] outline -outline-offset-2 outline-[#315c49]' : 'hover:bg-[#edf3ea]'}`}
                data-active={choice.id === active?.id}
                id={`${listId}-${index}`}
                key={choice.id || '__root__'}
                onClick={() => select(choice.id)}
                onPointerDown={(event) => { if (event.pointerType !== 'touch') event.preventDefault() }}
                role="option"
              >
                <span className="min-w-0 flex-1">{choice.label}</span>
                {choice.id === value && <span aria-hidden="true" className="shrink-0">✓</span>}
              </li>
            ))}
          </ul>
          <p className={filtered.length ? 'sr-only' : 'px-1 py-3 text-sm text-[#66796f]'} role="status">
            {filtered.length ? `${filtered.length} categorías disponibles` : 'No encontramos categorías con esa búsqueda'}
          </p>
          <div className="mt-2 flex flex-wrap justify-between gap-2">
            {clearLabel !== null ? (
              <button className="min-h-11 px-2 text-sm font-semibold text-[#52675d] disabled:opacity-50" disabled={!value} onClick={() => select('')} type="button">
                {clearLabel}
              </button>
            ) : <span />}
            <button className="min-h-11 px-2 text-sm font-semibold text-[#315c49]" onClick={close} type="button">Cerrar selector</button>
          </div>
        </div>
      )}
    </div>
  )
}
