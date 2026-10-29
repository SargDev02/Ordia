import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FinancialCategory, FinancialTransaction, TransactionKind } from '../types/finance'
import { FormDialog } from './FormDialog'
import { TransactionForm } from './TransactionForm'

const mocks = vi.hoisted(() => ({ categories: [] as FinancialCategory[], create: vi.fn(), update: vi.fn(), dirty: vi.fn(), close: vi.fn(), saved: vi.fn() }))
vi.mock('../finance/useFinance', () => ({ useFinance: () => ({
  categories: mocks.categories,
  accounts: [{ id: 'account', name: 'Principal', archived_at: null }, { id: 'destination', name: 'Ahorros', archived_at: null }],
  createTransaction: mocks.create, updateTransaction: mocks.update,
}) }))

function category(id: string, name: string, parent_id: string | null = null, kind: 'expense' | 'income' = 'expense', archived_at: string | null = null): FinancialCategory {
  return { id, name, parent_id, kind, archived_at, user_id: 'user', created_at: '', updated_at: '' }
}
function movement(categoryId = 'phone', kind: TransactionKind = 'expense'): FinancialTransaction {
  return { id: 'movement', user_id: 'user', kind, account_id: 'account', destination_account_id: null, amount: 30000,
    occurred_on: '2026-10-28', category_id: categoryId, description: 'Plan actual', client_request_id: 'request',
    deleted_at: null, created_at: '', updated_at: '' }
}
function editor(transaction?: FinancialTransaction, initialKind: TransactionKind = 'expense') {
  return <FormDialog title="Movimiento" onClose={mocks.close}><TransactionForm initialKind={initialKind} transaction={transaction}
    onCancel={mocks.close} onDirtyChange={mocks.dirty} onSaved={mocks.saved} /></FormDialog>
}
async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText('Categoría'))
  const input = screen.getByRole('combobox', { name: 'Buscar categoría o subcategoría' })
  expect(input).toHaveFocus()
  return input
}
async function completeAmount(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText('Cuenta'), 'account')
  await user.type(screen.getByLabelText('Importe'), '45000')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.create.mockResolvedValue(undefined); mocks.update.mockResolvedValue(undefined)
  mocks.categories = [category('food', 'Alimentación'), category('services', 'Servicios'),
    category('phone', 'Telefonía', 'services'), category('internet', 'Internet', 'services'),
    category('work', 'Trabajo'), category('work-phone', 'Telefonía', 'work'),
    category('old', 'Antigua', 'services', 'expense', '2026-10-01'),
    category('other-old', 'Otra archivada', null, 'expense', '2026-10-01'),
    category('salary', 'Salario', null, 'income')]
})

describe('selector buscable en movimientos', () => {
  it('busca una categoría principal con tildes, mayúsculas y espacios y muestra sus subcategorías elegibles', async () => {
    const user = userEvent.setup(); render(editor())
    const search = await openPicker(user)
    await user.type(search, '  SERVÍCIOS  ')
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map(option => option.textContent?.replace('✓', ''))).toEqual(['Servicios', 'Servicios → Internet', 'Servicios → Telefonía'])
    expect(screen.queryByRole('option', { name: /Antigua|Salario|Trabajo/ })).not.toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.dirty).not.toHaveBeenCalled()
  })

  it('distingue nombres repetidos por su padre y crea con el identificador elegido, sin crear categorías', async () => {
    const user = userEvent.setup(); render(editor())
    await completeAmount(user)
    await user.type(await openPicker(user), 'telefonia')
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2)
    await user.click(screen.getByRole('option', { name: 'Trabajo → Telefonía' }))
    expect(screen.getByLabelText('Categoría')).toHaveTextContent('Trabajo → Telefonía')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Categoría')).toHaveFocus()
    expect(mocks.create).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Guardar movimiento' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ category_id: 'work-phone', kind: 'expense' })))
  })

  it('selecciona con flechas y Enter sin enviar el formulario y conserva el foco', async () => {
    const user = userEvent.setup(); render(editor())
    const search = await openPicker(user)
    await user.type(search, 'telefonía')
    const first = screen.getByRole('option', { name: 'Servicios → Telefonía' })
    expect(search).toHaveAttribute('aria-activedescendant', first.id)
    await user.keyboard('{ArrowDown}')
    expect(search).toHaveAttribute('aria-activedescendant', screen.getByRole('option', { name: 'Trabajo → Telefonía' }).id)
    await user.keyboard('{ArrowUp}{Enter}')
    expect(screen.getByLabelText('Categoría')).toHaveTextContent('Servicios → Telefonía')
    expect(screen.getByLabelText('Categoría')).toHaveFocus()
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.saved).not.toHaveBeenCalled()
    expect(mocks.dirty).toHaveBeenCalledWith(true)
  })

  it('muestra el vacío y consume Enter incluso sin resultados o durante composición', async () => {
    const user = userEvent.setup(); render(editor())
    const search = await openPicker(user)
    await user.type(search, 'inexistente')
    expect(screen.getByText('No encontramos categorías con esa búsqueda')).toBeInTheDocument()
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}')
    expect(screen.getByRole('combobox', { name: 'Buscar categoría o subcategoría' })).toHaveFocus()
    await user.clear(search)
    fireEvent.keyDown(search, { key: 'Enter', isComposing: true })
    expect(screen.getByRole('combobox', { name: 'Buscar categoría o subcategoría' })).toHaveFocus()
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.dirty).not.toHaveBeenCalled()
  })

  it('Escape cierra primero el selector y después llega al diálogo; Tab no pierde su foco contenido', async () => {
    const user = userEvent.setup(); render(editor())
    await user.keyboard('{Tab}{Tab}')
    const trigger = screen.getByLabelText('Categoría')
    trigger.focus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('combobox', { name: 'Buscar categoría o subcategoría' })).toHaveFocus()
    await user.tab()
    expect(screen.getByRole('button', { name: 'Limpiar selección' })).toHaveFocus()
    await user.tab({ shift: true })
    expect(screen.getByRole('combobox', { name: 'Buscar categoría o subcategoría' })).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('combobox', { name: 'Buscar categoría o subcategoría' })).not.toBeInTheDocument()
    expect(trigger).toHaveFocus(); expect(mocks.close).not.toHaveBeenCalled()
    await user.keyboard('{Escape}')
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it.each(['phone', 'old'])('muestra y conserva la selección existente %s al editar, incluida la archivada original', async (id) => {
    const user = userEvent.setup(); render(editor(movement(id)))
    const label = id === 'old' ? 'Servicios → Antigua (archivada)' : 'Servicios → Telefonía'
    expect(screen.getByLabelText('Categoría')).toHaveTextContent(label)
    await openPicker(user)
    expect(screen.getByRole('option', { name: label })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('option', { name: 'Otra archivada (archivada)' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await user.type(screen.getByLabelText('Descripción (opcional)'), ' editado')
    await user.click(screen.getByRole('button', { name: 'Guardar movimiento' }))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('movement', expect.objectContaining({ category_id: id })))
  })

  it('permite cambiar la subcategoría de un ingreso al editar y persiste su ID', async () => {
    mocks.categories.push(category('bonus', 'Bonificación', 'salary', 'income'))
    const user = userEvent.setup(); render(editor(movement('salary', 'income')))
    await user.type(await openPicker(user), 'bonificacion')
    await user.click(screen.getByRole('option', { name: 'Salario → Bonificación' }))
    await user.click(screen.getByRole('button', { name: 'Guardar movimiento' }))
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith('movement', expect.objectContaining({ category_id: 'bonus', kind: 'income' })))
  })

  it('mantiene las reglas del cambio de tipo y no añade categorías a las transferencias', async () => {
    const user = userEvent.setup(); render(editor())
    await user.selectOptions(screen.getByLabelText('Tipo'), 'income')
    expect(screen.getByLabelText('Categoría')).toHaveTextContent('Salario')
    await openPicker(user)
    expect(within(screen.getByRole('listbox')).getAllByRole('option').map(option => option.textContent?.replace('✓', ''))).toEqual(['Salario'])
    await user.selectOptions(screen.getByLabelText('Tipo'), 'expense')
    expect(screen.queryByRole('combobox', { name: 'Buscar categoría o subcategoría' })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Categoría')).toHaveTextContent('Alimentación')
    await user.selectOptions(screen.getByLabelText('Tipo'), 'transfer')
    expect(screen.queryByLabelText('Categoría')).not.toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Cuenta de origen'), 'account')
    await user.selectOptions(screen.getByLabelText('Cuenta de destino'), 'destination')
    await user.type(screen.getByLabelText('Importe'), '45000')
    await user.click(screen.getByRole('button', { name: 'Guardar movimiento' }))
    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ category_id: null, kind: 'transfer', destination_account_id: 'destination' })))
  })

  it('conserva la validación de categoría obligatoria al limpiar o no tener categorías del tipo', async () => {
    const user = userEvent.setup(); const view = render(editor())
    await completeAmount(user)
    await openPicker(user)
    await user.click(screen.getByRole('button', { name: 'Limpiar selección' }))
    await user.click(screen.getByRole('button', { name: 'Guardar movimiento' }))
    expect(screen.getByText('Selecciona una categoría activa.')).toBeInTheDocument()
    mocks.categories = mocks.categories.filter(category => category.kind !== 'income')
    view.rerender(editor())
    await user.selectOptions(screen.getByLabelText('Tipo'), 'income')
    expect(screen.getByLabelText('Categoría')).toHaveTextContent('Selecciona una categoría')
    expect(screen.getByText(/No hay categorías activas de este tipo/)).toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('refleja altas, renombrados y archivado recibidos en memoria sin perder la búsqueda', async () => {
    const user = userEvent.setup(); const view = render(editor())
    const search = await openPicker(user); await user.type(search, 'telefonia')
    mocks.categories = mocks.categories.map(category => category.id === 'services' ? { ...category, name: 'Servicios del hogar' } : category)
    mocks.categories.push(category('new-phone', 'Telefonía móvil', 'services'))
    view.rerender(editor())
    expect(search).toHaveValue('telefonia')
    expect(screen.getByRole('option', { name: 'Servicios del hogar → Telefonía móvil' })).toBeInTheDocument()
    mocks.categories = mocks.categories.map(category => category.id === 'new-phone' ? { ...category, archived_at: '2026-10-28' } : category)
    view.rerender(editor())
    expect(screen.queryByRole('option', { name: /Telefonía móvil/ })).not.toBeInTheDocument()
    expect(mocks.create).not.toHaveBeenCalled(); expect(mocks.dirty).not.toHaveBeenCalled()
  })

  it('conserva lo escrito, la selección y la petición idempotente tras un error de guardado', async () => {
    const user = userEvent.setup(); mocks.create.mockRejectedValueOnce(new Error('Sin conexión'))
    render(editor()); await completeAmount(user)
    await user.type(await openPicker(user), 'telefonia')
    await user.click(screen.getByRole('option', { name: 'Servicios → Telefonía' }))
    await user.click(screen.getByRole('button', { name: 'Guardar movimiento' }))
    expect(await screen.findByText('Sin conexión')).toBeInTheDocument()
    expect(screen.getByLabelText('Importe')).toHaveValue(45000)
    expect(screen.getByLabelText('Categoría')).toHaveTextContent('Servicios → Telefonía')
    await user.click(screen.getByRole('button', { name: 'Guardar movimiento' }))
    await waitFor(() => expect(mocks.saved).toHaveBeenCalledOnce())
    expect(mocks.create.mock.calls[0][0]).toBe(mocks.create.mock.calls[1][0])
  })
})
