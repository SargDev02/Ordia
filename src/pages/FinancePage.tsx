import { FinanceProvider } from '../finance/FinanceContext'
import { FixedExpensesPage } from './FixedExpensesPage'
import { HomePage } from './HomePage'

export default function FinancePage({ view }: { view: 'home' | 'fixed-expenses' }) {
  return (
    <FinanceProvider>
      {view === 'home' ? <HomePage /> : <FixedExpensesPage />}
    </FinanceProvider>
  )
}
