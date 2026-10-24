from pathlib import Path
p=Path('frontend/src/pages/Invoicing.jsx')
s=p.read_text(encoding='utf-8')
old='w-[95vw] max-w-5xl h-[94vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0 [&>button.absolute]:hidden'
assert old in s
# Restore the unrelated GST Reports modal.
s=s.replace(old, 'max-w-5xl max-h-[94vh] overflow-hidden flex flex-col rounded-2xl border shadow-2xl p-0 [&>button.absolute]:hidden', 1)
# Target the InvoiceForm dialog specifically.
anchor='const InvoiceForm = ({ open, onClose, editingInv, companies, clients, leads, onSuccess, isDark, itemSuggestions }) => {'
pos=s.index(anchor)
idx=s.index('<DialogContent className={`max-w-5xl max-h-[94vh] overflow-hidden flex flex-col rounded-2xl', pos)
s=s[:idx]+s[idx:].replace('max-w-5xl max-h-[94vh] overflow-hidden flex flex-col rounded-2xl','w-[95vw] max-w-5xl h-[94vh] overflow-hidden flex flex-col rounded-2xl',1)
p.write_text(s,encoding='utf-8')
