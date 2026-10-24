from pathlib import Path
p=Path('frontend/src/pages/Invoicing.jsx')
s=p.read_text(encoding='utf-8')
# Restore ProductModal's accidental sizing change.
product='const ProductModal = ({ open, onClose, isDark, onSaved, invoices = [] }) => {'
pos=s.index(product)
idx=s.index('<DialogContent className={`w-[95vw] max-w-5xl h-[94vh] overflow-hidden flex flex-col rounded-2xl', pos)
s=s[:idx]+s[idx:].replace('w-[95vw] max-w-5xl h-[94vh] overflow-hidden flex flex-col rounded-2xl','max-w-5xl max-h-[94vh] overflow-hidden flex flex-col rounded-2xl',1)
# Fix the actual InvoiceForm modal.
inv='const InvoiceForm = ({ open, onClose, editingInv, companies, clients, leads, onSuccess, isDark, itemSuggestions }) => {'
pos=s.index(inv)
idx=s.index('<DialogContent className={`max-w-5xl max-h-[96vh] overflow-hidden flex flex-col rounded-2xl', pos)
s=s[:idx]+s[idx:].replace('max-w-5xl max-h-[96vh] overflow-hidden flex flex-col rounded-2xl','w-[95vw] max-w-5xl h-[94vh] overflow-hidden flex flex-col rounded-2xl',1)
p.write_text(s,encoding='utf-8')
