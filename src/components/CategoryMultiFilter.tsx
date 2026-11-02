import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { normalizeCategorySearch } from '../finance/calculations'
import type { FinancialCategory, FinancialTransaction } from '../types/finance'

interface CategoryMultiFilterProps {
  id: string
  categories: FinancialCategory[]
  transactions: FinancialTransaction[]
  selectedIds: string[]
  onToggle: (categoryId: string) => void
  onClear: () => void
}

interface FilterCategoryChoice {
  id: string
  label: string
  search: string
}

export function CategoryMultiFilter({
  id,
  categories,
  transactions,
  selectedIds,
  onToggle,
  onClear,
}: CategoryMultiFilterProps) {
  const uid = useId()
  const listId = `${uid}-multi-options`
  const hintId = `${uid}-multi-hint`
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const choices = useMemo<FilterCategoryChoice[]>(() => {
    const byId = new Map(categories.map((category) => [category.id, category]))

    // Incluir categorías activas y categorías archivadas que tengan movimientos históricos del usuario (o estén seleccionadas)
    const historicalCategoryIds = new Set<string>()
    for (const tx of transactions) {
      if (!tx.deleted_at && tx.category_id) {
        historicalCategoryIds.add(tx.category_id)
        const cat = byId.get(tx.category_id)
        if (cat?.parent_id) {
          historicalCategoryIds.add(cat.parent_id)
        }
      }
    }

    const eligible = categories.filter(
      (category) =>
        !category.archived_at ||
        historicalCategoryIds.has(category.id) ||
        selectedSet.has(category.id),
    )

    const incomeNames = new Set<string>()
    const expenseNames = new Set<string>()
    for (const category of eligible) {
      const parent = category.parent_id ? byId.get(category.parent_id) : null
      const path = parent ? `${parent.name} → ${category.name}` : category.name
      const normName = normalizeCategorySearch(category.name)
      const normPath = normalizeCategorySearch(path)
      if (category.kind === 'income') {
        incomeNames.add(normName)
        incomeNames.add(normPath)
      } else {
        expenseNames.add(normName)
        expenseNames.add(normPath)
      }
    }

    return eligible
      .map((category) => {
        const parent = category.parent_id ? byId.get(category.parent_id) : null
        const path = parent ? `${parent.name} → ${category.name}` : category.name
        const normName = normalizeCategorySearch(category.name)
        const normPath = normalizeCategorySearch(path)
        const collidesAcrossKinds =
          category.kind === 'income'
            ? expenseNames.has(normName) || expenseNames.has(normPath)
            : incomeNames.has(normName) || incomeNames.has(normPath)

        const kindSuffix = collidesAcrossKinds
          ? category.kind === 'income'
            ? ' · Ingreso'
            : ' · Gasto'
          : ''
        const archivedSuffix = category.archived_at ? ' (archivada)' : ''
        const label = `${path}${kindSuffix}${archivedSuffix}`
        const kindWord = category.kind === 'income' ? 'ingreso' : 'gasto'

        return {
          id: category.id,
          label,
          pathSortKey: `${path.toLowerCase()}::${category.kind}`,
          search: normalizeCategorySearch(`${path} ${label} ${kindWord}`),
        }
      })
      .sort((a, b) => a.pathSortKey.localeCompare(b.pathSortKey, 'es'))
      .map(({ id: choiceId, label, search }) => ({ id: choiceId, label, search }))
  }, [categories, selectedSet, transactions])

  const choiceById = useMemo(() => new Map(choices.map((c) => [c.id, c])), [choices])

  const terms = normalizeCategorySearch(query).split(' ').filter(Boolean)
  const filtered = choices.filter((choice) => terms.every((term) => choice.search.includes(term)))
  const active =
    (activeId !== null ? filtered.find((choice) => choice.id === activeId) : undefined) ?? filtered[0]
  const activeIndex = active ? filtered.indexOf(active) : -1

  function open(last = false) {
    setQuery('')
    setActiveId(last ? (choices.at(-1)?.id ?? null) : (selectedIds[0] ?? choices[0]?.id ?? null))
    setExpanded(true)
  }

  function close() {
    setExpanded(false)
    triggerRef.current?.focus()
  }

  useLayoutEffect(() => {
    if (!expanded) return
    inputRef.current?.focus()
  }, [expanded])

  useEffect(() => {
    if (!expanded) return
    const viewport = window.visualViewport
    function fitResults() {
      const height = viewport?.height ?? window.innerHeight
      rootRef.current?.style.setProperty(
        '--category-multi-results-height',
        `${Math.max(96, Math.min(256, height * 0.35))}px`,
      )
    }
    function outside(event: PointerEvent) {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setExpanded(false)
      }
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
    if (optionBounds.top < bounds.top) list.scrollTop -= bounds.top - optionBounds.top
    else if (optionBounds.bottom > bounds.bottom) list.scrollTop += optionBounds.bottom - bounds.bottom
  }, [expanded, active?.id])

  const buttonSummary =
    selectedIds.length === 0
      ? 'Todas las categorías'
      : selectedIds.length === 1
        ? (choiceById.get(selectedIds[0])?.label ?? '1 categoría seleccionada')
        : `${selectedIds.length} categorías seleccionadas`

  const selectedChips = selectedIds
    .map((selectedId) => choiceById.get(selectedId))
    .filter((item): item is FilterCategoryChoice => Boolean(item))

  return (
    <div
      className="min-w-0"
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          setExpanded(false)
        }
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
      <label className="mb-1.5 block text-xs font-semibold text-[#66796f]" htmlFor={id}>
        Categorías
      </label>
      <button
        aria-controls={expanded ? listId : undefined}
        aria-expanded={expanded}
        aria-haspopup="listbox"
        className="flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-[#d6e1d3] bg-white px-3 py-2.5 text-left text-sm text-[#173f31] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#315c49]"
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
        <span className="min-w-0 flex-1 truncate">{buttonSummary}</span>
        <span aria-hidden="true" className="shrink-0 text-[#66796f]">
          {expanded ? '▴' : '▾'}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 min-w-0 rounded-2xl border border-[#c6d7c3] bg-[#f8faf6] p-3 shadow-sm">
          <label className="mb-1.5 block text-xs font-semibold text-[#264a3c]" htmlFor={`${uid}-search`}>
            Buscar categorías para filtrar
          </label>
          <input
            aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls={listId}
            aria-describedby={hintId}
            aria-expanded="true"
            autoComplete="off"
            className="min-h-11 w-full min-w-0 rounded-xl border border-[#c6d7c3] bg-white px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-[#315c49]"
            enterKeyHint="done"
            id={`${uid}-search`}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveId(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                if (!event.nativeEvent.isComposing && active) {
                  onToggle(active.id)
                }
              } else if (
                !event.nativeEvent.isComposing &&
                (event.key === 'ArrowDown' || event.key === 'ArrowUp')
              ) {
                event.preventDefault()
                if (filtered.length === 0) return
                const next = event.key === 'ArrowDown' ? activeIndex + 1 : activeIndex - 1
                const target = filtered[(next + filtered.length) % filtered.length]
                setActiveId(target ? target.id : null)
              }
            }}
            placeholder="Escribe categoría o subcategoría…"
            ref={inputRef}
            role="combobox"
            type="text"
            value={query}
          />
          <p className="sr-only" id={hintId}>
            Usa las flechas arriba y abajo y Enter para marcar o desmarcar categorías. Escape cierra el filtro.
          </p>
          <ul
            aria-label="Categorías para filtrar"
            aria-multiselectable="true"
            className="mt-2 max-h-[min(16rem,35dvh)] overflow-y-auto overscroll-contain rounded-xl bg-white"
            id={listId}
            ref={listRef}
            role="listbox"
            style={{ maxHeight: 'var(--category-multi-results-height, min(16rem,35dvh))' }}
          >
            {filtered.map((choice, index) => {
              const isSelected = selectedSet.has(choice.id)
              return (
                <li
                  aria-selected={isSelected}
                  className={`flex min-h-11 cursor-pointer items-center gap-2.5 px-3 py-2.5 text-sm [overflow-wrap:anywhere] ${
                    choice.id === active?.id
                      ? 'bg-[#e3eddf] outline -outline-offset-2 outline-[#315c49]'
                      : 'hover:bg-[#edf3ea]'
                  }`}
                  data-active={choice.id === active?.id}
                  id={`${listId}-${index}`}
                  key={choice.id}
                  onClick={() => onToggle(choice.id)}
                  onPointerDown={(event) => {
                    if (event.pointerType !== 'touch') event.preventDefault()
                  }}
                  role="option"
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-xs ${
                      isSelected
                        ? 'border-[#173f31] bg-[#173f31] text-white'
                        : 'border-[#9ab0a3] bg-white text-transparent'
                    }`}
                  >
                    ✓
                  </span>
                  <span className="min-w-0 flex-1">{choice.label}</span>
                </li>
              )
            })}
          </ul>
          <p className={filtered.length ? 'sr-only' : 'px-1 py-3 text-xs text-[#66796f]'} role="status">
            {filtered.length
              ? `${filtered.length} categorías disponibles`
              : 'No encontramos categorías con esa búsqueda'}
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <button
              className="min-h-10 px-2 text-xs font-semibold text-[#52675d] disabled:opacity-50"
              disabled={selectedIds.length === 0}
              onClick={() => onClear()}
              type="button"
            >
              Limpiar categorías
            </button>
            <button
              className="min-h-10 px-2 text-xs font-semibold text-[#315c49]"
              onClick={close}
              type="button"
            >
              Cerrar selector
            </button>
          </div>
        </div>
      )}

      {selectedChips.length > 0 && (
        <div
          aria-label="Categorías seleccionadas"
          className="mt-2 flex flex-wrap items-center gap-1.5"
        >
          {selectedChips.map((chip) => (
            <span
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-[#c6d7c3] bg-[#edf3ea] px-2.5 py-1 text-xs font-medium text-[#173f31]"
              key={chip.id}
            >
              <span className="min-w-0 break-words">{chip.label}</span>
              <button
                aria-label={`Quitar categoría ${chip.label}`}
                className="shrink-0 rounded-full px-1 font-bold text-[#315c49] hover:bg-[#d6e5d1]"
                onClick={() => onToggle(chip.id)}
                type="button"
              >
                ×
              </button>
            </span>
          ))}
          {!expanded && (
            <button
              className="rounded-full px-2.5 py-1 text-xs font-semibold text-[#346a52] underline underline-offset-2 hover:text-[#173f31]"
              onClick={() => onClear()}
              type="button"
            >
              Limpiar categorías
            </button>
          )}
        </div>
      )}
    </div>
  )
}
