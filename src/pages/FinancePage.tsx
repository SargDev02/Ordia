import { FinanceProvider } from '../finance/FinanceContext'
import { HomePage } from './HomePage'

export default function FinancePage() {
  return (
    <FinanceProvider>
      <HomePage />
    </FinanceProvider>
  )
}
