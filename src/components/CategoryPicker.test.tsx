import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FinancialCategory } from '../types/finance'
import { CategoryPicker } from './CategoryPicker'

const categories: FinancialCategory[] = [
  { id: 'parent', name: 'Servicios', parent_id: null, kind: 'expense', user_id: 'user', archived_at: null, created_at: '', updated_at: '' },
  { id: 'phone', name: 'Telefonía', parent_id: 'parent', kind: 'expense', user_id: 'user', archived_at: null, created_at: '', updated_at: '' },
]
const originalViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport')

afterEach(() => {
  if (originalViewport) Object.defineProperty(window, 'visualViewport', originalViewport)
  else Reflect.deleteProperty(window, 'visualViewport')
  vi.restoreAllMocks()
})

describe('foco, viewport y ciclo de vida del selector', () => {
  it('expone la selección existente como descripción accesible del control', () => {
    render(<CategoryPicker id="category" categories={categories} options={categories} value="phone" onChange={vi.fn()} />)
    expect(screen.getByLabelText('Categoría')).toHaveAccessibleDescription('Servicios → Telefonía')
  })

  it('ajusta el espacio visible y libera los listeners al cerrar y desmontar', async () => {
    const viewport = Object.assign(new EventTarget(), { height: 700 })
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport })
    const addViewport = vi.spyOn(viewport, 'addEventListener')
    const removeViewport = vi.spyOn(viewport, 'removeEventListener')
    const addDocument = vi.spyOn(document, 'addEventListener')
    const removeDocument = vi.spyOn(document, 'removeEventListener')
    const user = userEvent.setup()
    const view = render(<CategoryPicker id="category" categories={categories} options={categories} value="phone" onChange={vi.fn()} />)
    const trigger = screen.getByLabelText('Categoría')
    const root = trigger.parentElement!
    expect(addViewport).not.toHaveBeenCalled()
    await user.click(trigger)
    expect(Number.parseFloat(root.style.getPropertyValue('--category-results-height'))).toBeCloseTo(245)
    const resizeListener = addViewport.mock.calls.find(([type]) => type === 'resize')![1]
    const pointerListener = addDocument.mock.calls.find(([type]) => type === 'pointerdown')![1]
    viewport.height = 300
    viewport.dispatchEvent(new Event('resize'))
    expect(Number.parseFloat(root.style.getPropertyValue('--category-results-height'))).toBeCloseTo(105)
    const closedHeight = root.style.getPropertyValue('--category-results-height')
    await user.keyboard('{Escape}')
    expect(removeViewport).toHaveBeenCalledWith('resize', resizeListener)
    expect(removeDocument).toHaveBeenCalledWith('pointerdown', pointerListener)
    viewport.height = 500
    viewport.dispatchEvent(new Event('resize'))
    expect(root.style.getPropertyValue('--category-results-height')).toBe(closedHeight)
    await user.click(trigger)
    const secondResizeListener = addViewport.mock.calls.at(-1)![1]
    const secondPointerListener = addDocument.mock.calls.filter(([type]) => type === 'pointerdown').at(-1)![1]
    view.unmount()
    expect(removeViewport).toHaveBeenCalledWith('resize', secondResizeListener)
    expect(removeDocument).toHaveBeenCalledWith('pointerdown', secondPointerListener)
    expect(removeViewport).toHaveBeenCalledTimes(2)
  })

  it('no cancela el gesto táctil de los resultados y permite seleccionar la opción', async () => {
    const onChange = vi.fn()
    const user = userEvent.setup()
    render(<CategoryPicker id="category" categories={categories} options={categories} value="parent" onChange={onChange} />)
    await user.click(screen.getByLabelText('Categoría'))
    const option = screen.getByRole('option', { name: 'Servicios → Telefonía' })
    const pointer = new Event('pointerdown', { bubbles: true, cancelable: true })
    Object.defineProperty(pointer, 'pointerType', { value: 'touch' })
    fireEvent(option, pointer)
    expect(pointer.defaultPrevented).toBe(false)
    fireEvent.click(option)
    expect(onChange).toHaveBeenCalledWith('phone')
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Categoría')).toHaveFocus()
  })

  it('no conserva búsqueda ni categorías al desmontar y montar los datos de otra sesión', async () => {
    const user = userEvent.setup()
    const first = render(<CategoryPicker id="category" categories={categories} options={categories} value="phone" onChange={vi.fn()} />)
    await user.click(screen.getByLabelText('Categoría'))
    await user.type(screen.getByRole('combobox'), 'telefonia')
    first.unmount()
    const other = [{ ...categories[0], id: 'other', name: 'Viajes', user_id: 'other-user' }]
    render(<CategoryPicker id="category" categories={other} options={other} value="other" onChange={vi.fn()} />)
    await user.click(screen.getByLabelText('Categoría'))
    expect(screen.getByRole('combobox')).toHaveValue('')
    expect(screen.getByRole('option', { name: 'Viajes' })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /Telefonía|Servicios/ })).not.toBeInTheDocument()
  })
})
