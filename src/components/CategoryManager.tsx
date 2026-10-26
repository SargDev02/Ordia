import { useMemo, useState, type FormEvent } from 'react'
import { useFinance } from '../finance/useFinance'
import type { FinancialCategory } from '../types/finance'
import { AuthNotice } from './AuthNotice'

interface CategoryManagerProps {
  onClose: () => void
  onDirtyChange: (isDirty: boolean) => void
}

export function CategoryManager({ onClose, onDirtyChange }: CategoryManagerProps) {
  const finance = useFinance()
  const [kind, setKind] = useState<'income' | 'expense'>('expense')
  const [parentId, setParentId] = useState('')
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [editingOriginalName, setEditingOriginalName] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const activeParents = useMemo(() => finance.categories.filter((category) =>
    category.kind === kind && !category.parent_id && !category.archived_at,
  ), [finance.categories, kind])

  async function handleCreate(event: FormEvent) {
    event.preventDefault()
    const cleanName = name.trim()
    if (!cleanName) return setError('Escribe un nombre para la categoría.')
    setIsSubmitting(true)
    setError('')
    try {
      await finance.createCategory({ kind, name: cleanName, parent_id: parentId || null })
      setName('')
      setParentId('')
      onDirtyChange(editingId !== null && editingName.trim() !== editingOriginalName)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos crear la categoría.')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleRename(category: FinancialCategory) {
    const cleanName = editingName.trim()
    if (!cleanName) return setError('El nombre no puede quedar vacío.')
    setIsSubmitting(true)
    setError('')
    try {
      await finance.renameCategory(category.id, cleanName)
      setEditingId(null)
      setEditingName('')
      setEditingOriginalName('')
      onDirtyChange(Boolean(name.trim() || parentId || kind !== 'expense'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos renombrar la categoría.')
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleArchive(category: FinancialCategory) {
    const detail = category.parent_id
      ? `¿Archivar “${category.name}”? Los movimientos anteriores conservarán esta referencia.`
      : `¿Archivar “${category.name}” y sus subcategorías? Los movimientos anteriores conservarán sus referencias.`
    if (!window.confirm(detail)) return
    setIsSubmitting(true)
    setError('')
    try {
      await finance.archiveCategory(category.id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'No pudimos archivar la categoría.')
    } finally {
      setIsSubmitting(false)
    }
  }

  function markDirty() {
    onDirtyChange(true)
  }

  function cancelRename() {
    setEditingId(null)
    setEditingName('')
    setEditingOriginalName('')
    onDirtyChange(Boolean(name.trim() || parentId || kind !== 'expense'))
  }

  function startRename(category: FinancialCategory) {
    setEditingId(category.id)
    setEditingName(category.name)
    setEditingOriginalName(category.name)
  }

  return (
    <div className="bg-white p-6 sm:p-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-[#4f8068]">Organización</p><h2 className="mt-2 text-2xl font-semibold text-[#173f31]">Administrar categorías</h2></div>
        <button className="text-sm font-semibold text-[#66796f]" disabled={isSubmitting} onClick={onClose} type="button">Cerrar</button>
      </div>
      <p className="mb-6 text-sm leading-6 text-[#66796f]">Puedes usar una categoría principal o una subcategoría. Al archivar una principal también se archivan sus subcategorías, sin alterar el historial.</p>
      {error && <div className="mb-5"><AuthNotice tone="error">{error}</AuthNotice></div>}

      <form className="rounded-2xl bg-[#f4f7f1] p-4" onChange={markDirty} onSubmit={handleCreate}>
        <h3 className="font-semibold text-[#264a3c]">Crear categoría</h3>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="category-kind">Tipo</label><select className="w-full rounded-xl border border-[#d6e1d3] bg-white px-3 py-3" data-dialog-initial-focus id="category-kind" onChange={(event) => { setKind(event.target.value as 'income' | 'expense'); setParentId('') }} value={kind}><option value="expense">Gasto</option><option value="income">Ingreso</option></select></div>
          <div><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="category-parent">Nivel</label><select className="w-full rounded-xl border border-[#d6e1d3] bg-white px-3 py-3" id="category-parent" onChange={(event) => setParentId(event.target.value)} value={parentId}><option value="">Categoría principal</option>{activeParents.map((category) => <option key={category.id} value={category.id}>Subcategoría de {category.name}</option>)}</select></div>
          <div className="sm:col-span-2"><label className="mb-2 block text-sm font-medium text-[#264a3c]" htmlFor="category-name">Nombre</label><input className="w-full rounded-xl border border-[#d6e1d3] bg-white px-3 py-3" id="category-name" maxLength={60} onChange={(event) => setName(event.target.value)} value={name} /></div>
        </div>
        <button className="mt-4 rounded-xl bg-[#173f31] px-4 py-3 font-semibold text-white disabled:opacity-60" disabled={isSubmitting} type="submit">{isSubmitting ? 'Guardando…' : 'Crear categoría'}</button>
      </form>

      <div className="mt-7 grid gap-6 lg:grid-cols-2">
        <CategoryList categories={finance.categories} editingId={editingId} editingName={editingName} isSubmitting={isSubmitting} kind="expense" onArchive={handleArchive} onCancelEdit={cancelRename} onEdit={startRename} onRename={handleRename} onRenameChange={(value) => { setEditingName(value); markDirty() }} />
        <CategoryList categories={finance.categories} editingId={editingId} editingName={editingName} isSubmitting={isSubmitting} kind="income" onArchive={handleArchive} onCancelEdit={cancelRename} onEdit={startRename} onRename={handleRename} onRenameChange={(value) => { setEditingName(value); markDirty() }} />
      </div>
    </div>
  )
}

function CategoryList({ categories, editingId, editingName, isSubmitting, kind, onArchive, onCancelEdit, onEdit, onRename, onRenameChange }: {
  categories: FinancialCategory[]
  editingId: string | null
  editingName: string
  isSubmitting: boolean
  kind: 'income' | 'expense'
  onArchive: (category: FinancialCategory) => void
  onCancelEdit: () => void
  onEdit: (category: FinancialCategory) => void
  onRename: (category: FinancialCategory) => void
  onRenameChange: (value: string) => void
}) {
  const roots = categories.filter((category) => category.kind === kind && !category.parent_id)
  return (
    <section aria-label={kind === 'expense' ? 'Categorías de gastos' : 'Categorías de ingresos'}>
      <h3 className="font-semibold text-[#264a3c]">{kind === 'expense' ? 'Gastos' : 'Ingresos'}</h3>
      <div className="mt-3 space-y-3">
        {roots.map((root) => <div className={`rounded-2xl border p-4 ${root.archived_at ? 'border-[#e1e5df] bg-[#f6f7f5] text-[#76837c]' : 'border-[#dce6d9]'}`} key={root.id}>
          <CategoryRow category={root} editingId={editingId} editingName={editingName} isSubmitting={isSubmitting} onArchive={onArchive} onCancelEdit={onCancelEdit} onEdit={onEdit} onRename={onRename} onRenameChange={onRenameChange} />
          <div className="ml-4 mt-3 space-y-2 border-l border-[#dce6d9] pl-3">{categories.filter((category) => category.parent_id === root.id).map((child) => <CategoryRow category={child} editingId={editingId} editingName={editingName} isSubmitting={isSubmitting} key={child.id} onArchive={onArchive} onCancelEdit={onCancelEdit} onEdit={onEdit} onRename={onRename} onRenameChange={onRenameChange} />)}</div>
        </div>)}
      </div>
    </section>
  )
}

function CategoryRow({ category, editingId, editingName, isSubmitting, onArchive, onCancelEdit, onEdit, onRename, onRenameChange }: {
  category: FinancialCategory
  editingId: string | null
  editingName: string
  isSubmitting: boolean
  onArchive: (category: FinancialCategory) => void
  onCancelEdit: () => void
  onEdit: (category: FinancialCategory) => void
  onRename: (category: FinancialCategory) => void
  onRenameChange: (value: string) => void
}) {
  if (editingId === category.id) return <div className="flex flex-col gap-2 sm:flex-row"><label className="sr-only" htmlFor={`rename-${category.id}`}>Nuevo nombre</label><input className="min-w-0 flex-1 rounded-lg border border-[#cbd9c8] px-3 py-2" id={`rename-${category.id}`} maxLength={60} onChange={(event) => onRenameChange(event.target.value)} value={editingName} /><button className="font-semibold text-[#2f664d]" disabled={isSubmitting} onClick={() => void onRename(category)} type="button">Guardar</button><button className="text-[#66796f]" onClick={onCancelEdit} type="button">Cancelar</button></div>
  return <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{category.name}{category.archived_at ? ' · Archivada' : ''}</span><span className="flex gap-3 text-xs font-semibold"><button className="text-[#346a52]" onClick={() => onEdit(category)} type="button">Renombrar</button>{!category.archived_at && <button className="text-[#8b554d]" disabled={isSubmitting} onClick={() => void onArchive(category)} type="button">Archivar</button>}</span></div>
}
