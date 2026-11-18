import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { CopAmountField } from './CopAmountField'
import { normalizeCopInput } from '../finance/copInput'

function Field({ initial = '' }) {
  const [value, setValue] = useState(initial)
  return <><CopAmountField id="money" label="Importe" value={value} onValueChange={setValue} signed /><output aria-label="Valor interno">{value || '(vacío)'}</output></>
}

it('formatea durante escritura, conserva pesos enteros grandes y distingue vacío de cero', async () => {
  const user = userEvent.setup(); render(<Field />)
  const input = screen.getByLabelText('Importe')
  await user.type(input, '1250000')
  expect(input).toHaveValue('1.250.000'); expect(screen.getByLabelText('Valor interno')).toHaveTextContent('1250000')
  await user.clear(input); expect(screen.getByLabelText('Valor interno')).toHaveTextContent('(vacío)')
  await user.type(input, '9000000000000'); expect(input).toHaveValue('9.000.000.000.000')
  expect(screen.getByLabelText('Valor interno')).toHaveTextContent('9000000000000')
  await user.clear(input); await user.type(input, '0'); expect(input).toHaveValue('0')
})

it('pega importes agrupados y rechaza centavos o formatos ambiguos sin convertirlos a otro importe', async () => {
  const user = userEvent.setup(); render(<Field />)
  const input = screen.getByLabelText('Importe') as HTMLInputElement
  await user.click(input); await user.paste('1.250.000')
  expect(input).toHaveValue('1.250.000'); expect(screen.getByLabelText('Valor interno')).toHaveTextContent('1250000')
  input.setSelectionRange(0, input.value.length); await user.paste('1.000,50')
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(screen.getByLabelText('Valor interno')).toHaveTextContent('1.000,50')
  expect(normalizeCopInput('1.000,50')).toBeNull()
  expect(normalizeCopInput('1,000')).toBeNull()
  expect(normalizeCopInput('-25.000', true)).toBe('-25000')
  expect(normalizeCopInput('-25.000')).toBeNull()
})

it('edita y reemplaza selecciones en medio del importe manteniendo el cursor', async () => {
  const user = userEvent.setup(); render(<Field initial="1250000" />)
  const input = screen.getByLabelText('Importe') as HTMLInputElement
  await user.click(input); input.setSelectionRange(2, 5)
  await user.keyboard('300')
  expect(input).toHaveValue('1.300.000')
  expect(input.selectionStart).toBe(5)
  await user.keyboard('{Backspace}')
  expect(input).toHaveValue('130.000')
  await user.clear(input); expect(input).toHaveValue('')
})

it('borrar junto a un punto elimina un dígito y no deja el cursor atrapado en el separador', async () => {
  render(<Field initial="1000" />)
  const input = screen.getByLabelText('Importe') as HTMLInputElement
  input.focus()
  fireEvent.input(input, { target: { value: '1000', selectionStart: 1 }, inputType: 'deleteContentBackward' })
  expect(input).toHaveValue('000')
})

it('inserta un pegado en medio y rechaza decimales escritos sin retirar sus signos', async () => {
  const user = userEvent.setup(); render(<Field initial="1000" />)
  const input = screen.getByLabelText('Importe') as HTMLInputElement
  await user.click(input); input.setSelectionRange(3, 3); await user.paste('2')
  expect(input).toHaveValue('10.200')
  expect(screen.getByLabelText('Valor interno')).toHaveTextContent('10200')
  await user.clear(input); await user.type(input, '1000.50')
  expect(screen.getByRole('alert')).toBeInTheDocument()
  expect(input).toHaveValue('1.000.50')
  expect(screen.getByLabelText('Valor interno')).not.toHaveTextContent('100050')
})
