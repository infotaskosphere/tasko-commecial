import React, { useState, useEffect, useRef } from 'react';
import GifLoader, { MiniLoader } from "@/components/ui/GifLoader.jsx";
import { useDark } from '@/hooks/useDark';
import { useAuth } from '@/contexts/AuthContext';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import api from '@/lib/api';
import { toast } from 'sonner';
import {
  Plus, Edit, Trash2, ArrowDownCircle, ArrowUpCircle,
  History, Search, ArrowUpDown, Printer,
  CheckSquare, Square, MinusSquare, XCircle,
  FileText, Clock, Sparkles, Loader2,
  Mail, MessageCircle, Download, Share2,
} from 'lucide-react';
import { format } from 'date-fns';
import { detectDocumentDuplicates } from '@/lib/aiDuplicateEngine';
import AIDuplicateDialog from '@/components/ui/AIDuplicateDialog';

// ─── Print styles ─────────────────────────────────────────────────────────────
const PRINT_STYLE = `
@media print {
  body * { visibility: hidden !important; }
  #doc-print-area, #doc-print-area * { visibility: visible !important; }
  #doc-print-area { position: fixed; inset: 0; padding: 24px; background: #fff; }
  @page { margin: 16mm; }
}`;

// ─── Row highlight: based on how long OUT ────────────────────────────────────
function getDocRowHighlight(doc, isDark) {
  if (doc.current_status === 'OUT' || doc.current_location === 'taken_by_client') {
    const log    = doc.movement_log || [];
    const lastOut = [...log].reverse().find(m => m.movement_type === 'OUT');
    if (lastOut) {
      const daysOut = Math.ceil((new Date() - new Date(lastOut.timestamp)) / (1000 * 60 * 60 * 24));
      if (daysOut > 30) return isDark ? 'bg-orange-950/40' : 'bg-orange-100';
      if (daysOut > 7)  return isDark ? 'bg-yellow-950/30' : 'bg-yellow-50';
    }
  }
  return '';
}

// ─── Pagination ───────────────────────────────────────────────────────────────
function PaginationBar({ currentPage, totalPages, totalItems, pageSize, onPageChange, isDark }) {
  if (totalPages <= 1) return null;
  const pageStart = (currentPage - 1) * pageSize;
  const pageWindow = (() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (currentPage <= 4) return [1, 2, 3, 4, 5, '…', totalPages];
    if (currentPage >= totalPages - 3) return [1, '…', totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
    return [1, '…', currentPage - 1, currentPage, currentPage + 1, '…', totalPages];
  })();
  const dimBg    = isDark ? 'rgba(255,255,255,0.06)' : '#f1f5f9';
  const dimHover = isDark ? 'rgba(255,255,255,0.12)' : '#e2e8f0';
  const btnBase  = { width: 30, height: 30, borderRadius: 8, border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, transition: 'background 0.12s' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderTop: `1px solid ${isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'}`, background: isDark ? '#1e293b' : '#F8FAFC', flexShrink: 0 }}>
      <p style={{ fontSize: 11, color: isDark ? '#64748b' : '#94a3b8', margin: 0 }}>
        <span style={{ fontWeight: 600, color: isDark ? '#94a3b8' : '#64748b' }}>{pageStart + 1}–{Math.min(pageStart + pageSize, totalItems)}</span>{' '}of{' '}
        <span style={{ fontWeight: 600, color: isDark ? '#94a3b8' : '#64748b' }}>{totalItems}</span> records
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button disabled={currentPage === 1} onClick={() => onPageChange(Math.max(1, currentPage - 1))}
          style={{ ...btnBase, background: dimBg, color: currentPage === 1 ? (isDark ? '#334155' : '#cbd5e1') : (isDark ? '#94a3b8' : '#64748b'), opacity: currentPage === 1 ? 0.4 : 1 }}
          onMouseEnter={e => { if (currentPage !== 1) e.currentTarget.style.background = dimHover; }}
          onMouseLeave={e => { e.currentTarget.style.background = dimBg; }}>‹</button>
        {pageWindow.map((p, i) => p === '…'
          ? <span key={`e${i}`} style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: isDark ? '#475569' : '#94a3b8' }}>…</span>
          : <button key={p} onClick={() => onPageChange(p)}
              style={{ ...btnBase, fontSize: 11, fontWeight: p === currentPage ? 700 : 500, background: p === currentPage ? 'linear-gradient(135deg,#4f46e5,#6366f1)' : dimBg, color: p === currentPage ? '#fff' : (isDark ? '#94a3b8' : '#64748b'), boxShadow: p === currentPage ? '0 2px 8px rgba(79,70,229,0.35)' : 'none' }}
              onMouseEnter={e => { if (p !== currentPage) e.currentTarget.style.background = dimHover; }}
              onMouseLeave={e => { if (p !== currentPage) e.currentTarget.style.background = dimBg; }}>{p}</button>
        )}
        <button disabled={currentPage === totalPages} onClick={() => onPageChange(Math.min(totalPages, currentPage + 1))}
          style={{ ...btnBase, background: dimBg, color: currentPage === totalPages ? (isDark ? '#334155' : '#cbd5e1') : (isDark ? '#94a3b8' : '#64748b'), opacity: currentPage === totalPages ? 0.4 : 1 }}
          onMouseEnter={e => { if (currentPage !== totalPages) e.currentTarget.style.background = dimHover; }}
          onMouseLeave={e => { e.currentTarget.style.background = dimBg; }}>›</button>
      </div>
      <p style={{ fontSize: 11, color: isDark ? '#475569' : '#cbd5e1', margin: 0 }}>Page {currentPage} / {totalPages}</p>
    </div>
  );
}

// ─── Document Table ───────────────────────────────────────────────────────────
function DocumentTable({ documentList, onEdit, onDelete, onMovement, onViewLog, onShowFullNotes, type, isDark, selectedIds, onToggleSelect, onToggleAll }) {
  const allSelected  = documentList.length > 0 && documentList.every(d => selectedIds.has(d.id));
  const someSelected = documentList.some(d => selectedIds.has(d.id)) && !allSelected;

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full table-fixed border-collapse" style={{minWidth:640}}>
        <colgroup>
          <col style={{ width: 36 }} />
          <col style={{ width: 36 }} />
          <col style={{ width: '20%' }} />
          <col style={{ width: '13%' }} />
          <col style={{ width: '18%' }} />
          <col style={{ width: '16%' }} />
          <col style={{ width: '17%' }} />
          <col style={{ width: 128 }} />
        </colgroup>
        <thead className={`border-b ${isDark ? 'bg-slate-800/80 border-slate-700' : 'bg-slate-50 border-slate-200'}`}>
          <tr>
            <th className="px-2 py-2.5">
              <button onClick={() => onToggleAll(documentList)} className="flex items-center justify-center">
                {allSelected
                  ? <CheckSquare className="h-4 w-4 text-indigo-500" />
                  : someSelected
                    ? <MinusSquare className="h-4 w-4 text-indigo-400" />
                    : <Square className="h-4 w-4 text-slate-400" />}
              </button>
            </th>
            <th className={`px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>#</th>
            <th className={`px-3 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Holder Name</th>
            <th className={`px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Type</th>
            <th className={`px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Associated With</th>
            <th className={`px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Last Movement</th>
            <th className={`px-2 py-2.5 text-left text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Notes</th>
            <th className={`px-2 py-2.5 text-right text-[10px] font-semibold uppercase tracking-wider ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Actions</th>
          </tr>
        </thead>
        <tbody className={`divide-y ${isDark ? 'divide-slate-700/60' : 'divide-slate-100'}`}>
          {documentList.map((doc, index) => {
            const highlight  = getDocRowHighlight(doc, isDark);
            const isSelected = selectedIds.has(doc.id);
            const lastMove   = doc.movement_log?.length > 0 ? doc.movement_log[doc.movement_log.length - 1] : null;

            return (
              <tr key={doc.id}
                onClick={() => onViewLog(doc)}
                className={`transition-colors cursor-pointer ${highlight} ${isSelected ? (isDark ? 'ring-1 ring-inset ring-indigo-500' : 'ring-1 ring-inset ring-indigo-300') : ''} ${isDark ? 'hover:bg-slate-700/30' : 'hover:bg-slate-50/80'}`}
                data-testid={`document-row-${doc.id}`}>

                <td className="px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <button onClick={() => onToggleSelect(doc.id)} className="flex items-center justify-center">
                    {isSelected ? <CheckSquare className="h-4 w-4 text-indigo-500" /> : <Square className="h-4 w-4 text-slate-400" />}
                  </button>
                </td>

                <td className={`px-2 py-2.5 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{index + 1}</td>
                <td className={`px-3 py-2.5 text-sm font-semibold truncate ${isDark ? 'text-slate-100' : 'text-slate-900'}`} title={doc.holder_name}>{doc.holder_name}</td>
                <td className={`px-2 py-2.5 text-xs truncate ${isDark ? 'text-slate-300' : 'text-slate-600'}`} title={doc.document_type || ''}>{doc.document_type || '—'}</td>
                <td className={`px-2 py-2.5 text-xs truncate ${isDark ? 'text-slate-300' : 'text-slate-600'}`} title={doc.associated_with || ''}>{doc.associated_with || '—'}</td>

                <td className="px-2 py-2.5">
                  {lastMove ? (
                    <Badge className={`text-[9px] px-1 py-0 font-semibold leading-tight ${lastMove.movement_type === 'IN' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                      {lastMove.movement_type} - {lastMove.person_name}
                    </Badge>
                  ) : (
                    <span className="text-[11px] text-slate-400 italic">No movement</span>
                  )}
                </td>

                <td className={`px-2 py-2.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                  {doc.notes ? <div className="text-xs truncate pr-4" title={doc.notes}>{doc.notes}</div> : <span className="text-xs text-slate-400 italic">—</span>}
                </td>

                <td className="px-1 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                  <div className="flex justify-end gap-0">
                    <Button variant="ghost" size="sm" onClick={() => onViewLog(doc)} className={`h-7 w-7 p-0 ${isDark ? 'hover:bg-slate-600' : 'hover:bg-slate-100'}`} title="View Detail">
                      <Share2 className="h-3.5 w-3.5 text-emerald-500" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onMovement(doc, type === 'IN' ? 'OUT' : 'IN')}
                      className={`h-7 w-7 p-0 ${type === 'IN' ? 'hover:bg-red-50 text-red-500' : 'hover:bg-emerald-50 text-emerald-600'}`}
                      title={type === 'IN' ? 'Mark as OUT' : 'Mark as IN'}>
                      {type === 'IN' ? <ArrowUpCircle className="h-3.5 w-3.5" /> : <ArrowDownCircle className="h-3.5 w-3.5" />}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onEdit(doc)} className={`h-7 w-7 p-0 ${isDark ? 'hover:bg-indigo-900/30' : 'hover:bg-indigo-50'} text-indigo-500`}>
                      <Edit className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => onDelete(doc.id)} className={`h-7 w-7 p-0 ${isDark ? 'hover:bg-red-900/30' : 'hover:bg-red-50'} text-red-500`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Document type options ────────────────────────────────────────────────────
const DOC_TYPE_OPTIONS = [
  { value: 'Agreement',       label: 'Agreement / Contract' },
  { value: 'NDA',             label: 'NDA' },
  { value: 'Purchase Order',  label: 'Purchase Order' },
  { value: 'Invoice',         label: 'Invoice / Bill' },
  { value: 'Cheque',          label: 'Cheque / Payment Receipt' },
  { value: 'PanCard',         label: 'PAN Card / Copy' },
  { value: 'Aadhar',          label: 'Aadhaar Card / Copy' },
  { value: 'GST Certificate', label: 'GST Registration Certificate' },
  { value: 'Incorporation',   label: 'Certificate of Incorporation' },
  { value: 'MOA',             label: 'Memorandum of Association (MOA)' },
  { value: 'AOA',             label: 'Articles of Association (AOA)' },
  { value: 'Bank Statement',  label: 'Bank Statement' },
  { value: 'Balance Sheet',   label: 'Financial Statement / Balance Sheet' },
  { value: 'ITR',             label: 'Income Tax Return (ITR)' },
  { value: 'Power of Attorney', label: 'Power of Attorney' },
  { value: 'Lease Agreement', label: 'Lease / Rent Agreement' },
  { value: 'License',         label: 'License / Permit' },
  { value: 'Trademark',       label: 'Trademark / IP Document' },
  { value: 'Correspondence',  label: 'Important Correspondence / Letter' },
  { value: 'Other',           label: 'Other' },
];

// ─── Main Component ───────────────────────────────────────────────────────────
export default function DocumentRegister() {
  const isDark    = useDark();
  const { user, hasPermission } = useAuth();
  const isAdmin = user?.role === 'admin';
  const canDeleteDoc = isAdmin || hasPermission('can_delete_data');
  const canEditDoc   = isAdmin || hasPermission('can_edit_data');
  const searchRef = useRef(null);

  const [documentList, setDocumentList]             = useState([]);
  const [loading, setLoading]                       = useState(false);
  const [dialogOpen, setDialogOpen]                 = useState(false);
  const [movementDialogOpen, setMovementDialogOpen] = useState(false);
  const [logDialogOpen, setLogDialogOpen]           = useState(false);
  const [fullNotesOpen, setFullNotesOpen]           = useState(false);
  const [selectedFullNotes, setSelectedFullNotes]   = useState({ holder_name: '', notes: '' });
  const [editingDocument, setEditingDocument]       = useState(null);
  const [selectedDocument, setSelectedDocument]     = useState(null);
  const [editingMovement, setEditingMovement]       = useState(null);
  const [searchQuery, setSearchQuery]               = useState('');
  const [rowsPerPage, setRowsPerPage]               = useState(15);
  const [currentPageIn, setCurrentPageIn]           = useState(1);
  const [currentPageOut, setCurrentPageOut]         = useState(1);
  const [sortOrder, setSortOrder]                   = useState('az');
  const [activeTab, setActiveTab]                   = useState('in');

  const [selectedIds, setSelectedIds]           = useState(new Set());
  const [bulkDialogOpen, setBulkDialogOpen]     = useState(false);
  const [bulkMovementType, setBulkMovementType] = useState('IN');
  const [bulkPersonName, setBulkPersonName]     = useState('');
  const [bulkNotes, setBulkNotes]               = useState('');
  const [bulkLoading, setBulkLoading]           = useState(false);
  // ── AI Duplicate detection ────────────────────────────────────────────────
  const [showDupDialog, setShowDupDialog] = useState(false);
  const [dupGroups,     setDupGroups]     = useState([]);
  const [detectingDups, setDetectingDups] = useState(false);

  const shareAreaRef = useRef(null);

  const [formData, setFormData] = useState({
    holder_name: '', document_type: 'Agreement', document_password: '',
    associated_with: '', entity_type: 'firm', issue_date: '', notes: '',
  });
  const [movementData, setMovementData]         = useState({ movement_type: 'IN', person_name: '', notes: '' });
  const [editMovementData, setEditMovementData] = useState({ movement_type: 'IN', person_name: '', notes: '' });

  useEffect(() => { fetchDocuments(); }, []);
  useEffect(() => { setCurrentPageIn(1); setCurrentPageOut(1); if (searchQuery.trim()) { setActiveTab('all'); } else { setActiveTab('in'); } }, [sortOrder, searchQuery]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    const styleEl = document.createElement('style');
    styleEl.innerHTML = PRINT_STYLE;
    document.head.appendChild(styleEl);
    return () => document.head.removeChild(styleEl);
  }, []);

  const handlePrint = () => window.print();

  // ── AI Duplicate Detection ─────────────────────────────────────────────────
  const handleDetectDocumentDuplicates = () => {
    if (detectingDups) return;
    setDetectingDups(true);
    setTimeout(() => {
      try {
        const groups = detectDocumentDuplicates(documentList);
        setDupGroups(groups);
        setShowDupDialog(true);
        if (!groups.length) toast.success(`Scanned ${documentList.length} documents — no duplicates found ✓`);
        else toast.info(`Found ${groups.length} duplicate group${groups.length !== 1 ? 's' : ''}`);
      } catch (e) {
        toast.error('Duplicate scan failed. Please try again.');
        console.error('Document duplicate detection error:', e);
      } finally {
        setDetectingDups(false);
      }
    }, 60);
  };

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const handleShare = async (method) => {
    if (!shareAreaRef.current) return;
    const canvas = await html2canvas(shareAreaRef.current, { 
      backgroundColor: isDark? '#0f172a' : '#ffffff',
      scale: 2 
    });
    const dataUrl = canvas.toDataURL('image/png');
    const name = selectedDocument?.holder_name || 'Document';
    const summaryText = `${name} Details Attached.`;

    if (method === 'whatsapp') {
      window.open(`https://wa.me/?text=${encodeURIComponent(summaryText)}`, '_blank');
    } else if (method === 'email') {
      window.location.href = `mailto:?subject=Document Details&body=${encodeURIComponent(summaryText)}`;
    } else if (method === 'download') {
      const link = document.createElement('a');
      link.download = `${name}_Details.png`;
      link.href = dataUrl;
      link.click();
    }
  };
  
  const fetchDocuments = async () => {
    setLoading(true);
    try {
      const response = await api.get('/documents');
      setDocumentList(response.data);
    } catch (error) {
      toast.error(getErrorMessage(error) || 'Failed to fetch documents');
    } finally {
      setLoading(false);
    }
  };

  // ── Submit ────────────────────────────────────────────────────────────────
  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      const documentData = { ...formData, issue_date: new Date(formData.issue_date).toISOString() };
      if (editingDocument) {
        await api.put(`/documents/${editingDocument.id}`, documentData);
        toast.success('Document updated successfully!');
      } else {
        await api.post('/documents', documentData);
        toast.success('Document added successfully!');
      }
      setDialogOpen(false);
      resetForm();
      fetchDocuments();
    } catch (error) {
      toast.error(getErrorMessage(error) || 'Failed to save document');
    } finally {
      setLoading(false);
    }
  };

  // ── Movement ──────────────────────────────────────────────────────────────
  const handleMovement = async (e) => {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post(`/documents/${selectedDocument.id}/movement`, movementData);
      toast.success(`Document marked as ${movementData.movement_type}!`);
      setMovementDialogOpen(false);
      setMovementData({ movement_type: 'IN', person_name: '', notes: '' });
      fetchDocuments();
    } catch (error) {
      toast.error(getErrorMessage(error) || 'Failed to record movement');
    } finally {
      setLoading(false);
    }
  };

  const openMovementDialog = (document, type) => {
    setSelectedDocument(document);
    setMovementData({ ...movementData, movement_type: type });
    setMovementDialogOpen(true);
  };

  const openLogDialog = (document) => { setSelectedDocument(document); setLogDialogOpen(true); };
  const openFullNotes = (doc) => {
    if (!doc.notes) return;
    setSelectedFullNotes({ holder_name: doc.holder_name || '—', notes: doc.notes });
    setFullNotesOpen(true);
  };

  const getDocumentInOutStatus = (document) => {
    if (!document) return 'OUT';
    if (document.current_status) return document.current_status;
    return document.current_location === 'with_company' ? 'IN' : 'OUT';
  };

  const handleMovementInModal = async () => {
    if (!editingDocument || !movementData.person_name) return;
    setLoading(true);
    try {
      const newType = getDocumentInOutStatus(editingDocument) === 'IN' ? 'OUT' : 'IN';
      await api.post(`/documents/${editingDocument.id}/movement`, { ...movementData, movement_type: newType });
      toast.success(`Document marked as ${newType}!`);
      setMovementData({ movement_type: 'IN', person_name: '', notes: '' });
      const response = await api.get('/documents');
      setDocumentList(response.data);
      const updated = response.data.find(d => d.id === editingDocument.id);
      if (updated) setEditingDocument(updated);
    } catch (error) {
      toast.error(getErrorMessage(error) || 'Failed to record movement');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateMovement = async (movementId) => {
    if (!editingDocument || !editMovementData.person_name) return;
    setLoading(true);
    try {
      await api.put(`/documents/${editingDocument.id}/movement/${movementId}`, {
        movement_id:   movementId,
        movement_type: editMovementData.movement_type,
        person_name:   editMovementData.person_name,
        notes:         editMovementData.notes,
      });
      toast.success('Movement log updated successfully!');
      setEditingMovement(null);
      const response = await api.get('/documents');
      setDocumentList(response.data);
      const updated = response.data.find(d => d.id === editingDocument.id);
      if (updated) setEditingDocument(updated);
    } catch (error) {
      toast.error(getErrorMessage(error) || 'Failed to update movement');
    } finally {
      setLoading(false);
    }
  };

  const startEditingMovement = (movement) => {
    setEditingMovement(movement.id || movement.timestamp);
    setEditMovementData({ movement_type: movement.movement_type, person_name: movement.person_name, notes: movement.notes || '' });
  };

  // ── Edit / Delete ─────────────────────────────────────────────────────────
  const handleEdit = (document) => {
    setEditingDocument(document);
    setFormData({
      holder_name:       document.holder_name,
      document_type:     document.document_type || 'Agreement',
      document_password: document.document_password || '',
      associated_with:   document.associated_with || '',
      entity_type:       document.entity_type || 'firm',
      issue_date:        format(new Date(document.issue_date), 'yyyy-MM-dd'),
      notes:             document.notes || '',
    });
    setMovementData({ movement_type: 'IN', person_name: '', notes: '' });
    setEditingMovement(null);
    setDialogOpen(true);
  };

  const handleDelete = async (documentId) => {
    if (!window.confirm('Are you sure you want to delete this document?')) return;
    try {
      await api.delete(`/documents/${documentId}`);
      toast.success('Document deleted successfully!');
      fetchDocuments();
    } catch (error) {
      toast.error(getErrorMessage(error) || 'Failed to delete document');
    }
  };

  const resetForm = () => {
    setFormData({ holder_name: '', document_type: 'Agreement', document_password: '', associated_with: '', entity_type: 'firm', issue_date: '', notes: '' });
    setEditingDocument(null);
  };

  const getErrorMessage = (error) => {
    const detail = error.response?.data?.detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) return detail.map(e => e.msg || e.message || JSON.stringify(e)).join(', ');
    if (detail && typeof detail === 'object') return detail.msg || detail.message || JSON.stringify(detail);
    return null;
  };

  const filterBySearch = (document) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      document.holder_name?.toLowerCase().includes(q) ||
      document.document_type?.toLowerCase().includes(q) ||
      document.associated_with?.toLowerCase().includes(q) ||
      document.notes?.toLowerCase().includes(q)
    );
  };

  // ── Sort ──────────────────────────────────────────────────────────────────
  const applySortOrder = (list) => {
    const arr = [...list];
    switch (sortOrder) {
      case 'az':   return arr.sort((a, b) => (a.holder_name || '').localeCompare(b.holder_name || ''));
      case 'za':   return arr.sort((a, b) => (b.holder_name || '').localeCompare(a.holder_name || ''));
      case 'fifo': return arr.sort((a, b) => new Date(a.issue_date) - new Date(b.issue_date));
      case 'lifo': return arr.sort((a, b) => new Date(b.issue_date) - new Date(a.issue_date));
      default:     return arr;
    }
  };

  const inDocuments  = applySortOrder(documentList.filter(doc => getDocumentInOutStatus(doc) === 'IN'  && filterBySearch(doc)));
  const outDocuments = applySortOrder(documentList.filter(doc => getDocumentInOutStatus(doc) === 'OUT' && filterBySearch(doc)));
  const allDocuments = applySortOrder(documentList.filter(doc => filterBySearch(doc)));

  // ── Stats ─────────────────────────────────────────────────────────────────
  const statsIn      = inDocuments.length;
  const statsOut     = outDocuments.length;
  const statsTotal   = documentList.length;
  const statsLongOut = documentList.filter(doc => {
    if (getDocumentInOutStatus(doc) !== 'OUT') return false;
    const log  = doc.movement_log || [];
    const last = [...log].reverse().find(m => m.movement_type === 'OUT');
    if (!last) return false;
    return Math.ceil((new Date() - new Date(last.timestamp)) / (1000 * 60 * 60 * 24)) > 30;
  }).length;

  // ── Pagination ─────────────────────────────────────────────────────────────
  const safePage = (cur, total) => Math.min(cur, Math.max(1, total));
  const tpIn  = Math.ceil(inDocuments.length  / rowsPerPage);
  const tpOut = Math.ceil(outDocuments.length / rowsPerPage);
  const spIn  = safePage(currentPageIn,  tpIn);
  const spOut = safePage(currentPageOut, tpOut);
  const pagedIn  = inDocuments.slice((spIn  - 1) * rowsPerPage, spIn  * rowsPerPage);
  const pagedOut = outDocuments.slice((spOut - 1) * rowsPerPage, spOut * rowsPerPage);

  // ── Bulk helpers ──────────────────────────────────────────────────────────
  const toggleSelect   = (id)  => setSelectedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
  const toggleAll      = (list) => {
    const allSel = list.every(d => selectedIds.has(d.id));
    setSelectedIds(prev => { const s = new Set(prev); list.forEach(d => allSel ? s.delete(d.id) : s.add(d.id)); return s; });
  };
  const clearSelection = () => setSelectedIds(new Set());

  const handleBulkMovement = async () => {
    if (!bulkPersonName.trim()) { toast.error('Person name is required'); return; }
    setBulkLoading(true);
    let success = 0; let failed = 0;
    for (const id of Array.from(selectedIds)) {
      try {
        await api.post(`/documents/${id}/movement`, { movement_type: bulkMovementType, person_name: bulkPersonName.trim(), notes: bulkNotes.trim() });
        success++;
      } catch { failed++; }
    }
    setBulkLoading(false);
    toast.success(`${success} document(s) marked as ${bulkMovementType}${failed > 0 ? `, ${failed} failed` : ''}`);
    setBulkDialogOpen(false);
    setBulkPersonName(''); setBulkNotes('');
    clearSelection();
    fetchDocuments();
  };

  const SORT_OPTIONS = [
    { value: 'az',   label: 'A → Z' },
    { value: 'za',   label: 'Z → A' },
    { value: 'fifo', label: 'FIFO (Oldest ↑)' },
    { value: 'lifo', label: 'LIFO (Newest ↓)' },
  ];

  const tabCard = () => ({
    background: isDark ? '#1e293b' : '#fff',
  });

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className={`min-h-screen ${isDark ? 'bg-[#0f172a]' : 'bg-slate-50'}`} data-testid="document-page">

      {/* ── Print area ── */}
      <div id="doc-print-area" className="hidden print:block">
        <h2 className="text-xl font-bold mb-2">Document Register — {format(new Date(), 'dd MMM yyyy')}</h2>
        <p className="text-sm text-slate-500 mb-4">Total: {statsTotal} | IN: {statsIn} | OUT: {statsOut}</p>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ background: '#f1f5f9' }}>
              {['#','Holder Name','Type','Associated With','Issue Date','Status','Last Movement'].map(h => (
                <th key={h} style={{ padding: '6px 8px', textAlign: 'left', border: '1px solid #e2e8f0', fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {documentList.map((doc, i) => {
              const last = doc.movement_log?.length > 0 ? doc.movement_log[doc.movement_log.length - 1] : null;
              return (
                <tr key={doc.id} style={{ background: i % 2 === 0 ? '#fff' : '#f8fafc' }}>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{i + 1}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{doc.holder_name}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{doc.document_type || '-'}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{doc.associated_with || '-'}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{doc.issue_date ? format(new Date(doc.issue_date), 'dd MMM yyyy') : '-'}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{getDocumentInOutStatus(doc)}</td>
                  <td style={{ padding: '5px 8px', border: '1px solid #e2e8f0' }}>{last ? `${last.movement_type} — ${last.person_name} (${format(new Date(last.timestamp), 'dd MMM yy')})` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Dashboard-style Banner Header ── */}
      <div className="relative overflow-hidden rounded-2xl"
        style={{ background: 'linear-gradient(135deg, #0D3B66 0%, #1F6FB2 60%, #1a8fcc 100%)', boxShadow: '0 8px 32px rgba(13,59,102,0.28)' }}>
        <div className="absolute right-0 top-0 w-72 h-72 rounded-full -mr-24 -mt-24 opacity-10"
          style={{ background: 'radial-gradient(circle, white 0%, transparent 70%)' }} />
        <div className="absolute right-28 bottom-0 w-40 h-40 rounded-full mb-[-40px] opacity-5"
          style={{ background: 'white' }} />
        <div className="absolute left-0 bottom-0 w-48 h-48 rounded-full -ml-20 -mb-20 opacity-5"
          style={{ background: 'white' }} />

        <div className="relative px-4 sm:px-6 pt-4 sm:pt-5 pb-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl bg-white/15 backdrop-blur-sm flex items-center justify-center flex-shrink-0 mt-0.5">
              <FileText className="h-5 w-5 text-white" />
            </div>
            <div>
              <p className="text-white/50 text-[10px] font-semibold uppercase tracking-widest mb-1">Registers</p>
              <h1 className="text-2xl font-bold text-white leading-tight">Document Register</h1>
              <p className="text-white/60 text-sm mt-0.5">Manage documents with IN/OUT tracking</p>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" onClick={handlePrint}
              className="h-9 px-4 gap-2 rounded-xl text-sm bg-white/10 border-white/25 text-white hover:bg-white/20 backdrop-blur-sm">
              <Printer className="h-4 w-4" />Print
            </Button>
            {/* ── AI Duplicate Detector ── */}
            <Button
              variant="outline"
              onClick={handleDetectDocumentDuplicates}
              disabled={detectingDups || documentList.length === 0}
              className="h-9 px-4 gap-2 rounded-xl text-sm backdrop-blur-sm font-semibold transition-all disabled:opacity-40"
              style={{ backgroundColor: 'rgba(139,92,246,0.25)', borderColor: 'rgba(167,139,250,0.6)', color: '#ede9fe' }}
            >
              {detectingDups
                ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Scanning…</>
                : <><Sparkles className="h-3.5 w-3.5" />AI Duplicates</>}
            </Button>
            <Dialog open={dialogOpen} onOpenChange={open => { setDialogOpen(open); if (!open) resetForm(); }}>
              <DialogTrigger asChild>
                <Button className="bg-white text-emerald-700 hover:bg-green-50 font-semibold rounded-xl px-5 shadow-lg transition-all hover:scale-105 active:scale-95" data-testid="add-document-btn">
                  <Plus className="mr-2 h-4 w-4" />Add Document
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="font-outfit text-2xl">{editingDocument ? 'Edit Document' : 'Add New Document'}</DialogTitle>
                  <DialogDescription>{editingDocument ? 'Update document details and track IN/OUT status.' : 'Fill in the details to add a new document.'}</DialogDescription>
                </DialogHeader>

                {editingDocument ? (
                  <Tabs defaultValue="details" className="w-full">
                    <TabsList className="grid w-full grid-cols-3">
                      <TabsTrigger value="details">Details</TabsTrigger>
                      <TabsTrigger value="status">IN/OUT Status</TabsTrigger>
                      <TabsTrigger value="history">History</TabsTrigger>
                    </TabsList>

                    <TabsContent value="details" className="mt-4">
                      <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="holder_name">Holder Name <span className="text-red-500">*</span></Label>
                            <Input id="holder_name" placeholder="Name of document holder" value={formData.holder_name}
                              onChange={e => setFormData({ ...formData, holder_name: e.target.value })} required data-testid="document-holder-name-input" />
                          </div>
                          <div className="space-y-2">
                            <Label>Document Type</Label>
                            <Select value={formData.document_type} onValueChange={v => setFormData({ ...formData, document_type: v })}>
                              <SelectTrigger id="document_type" data-testid="document-type-select"><SelectValue placeholder="Select document type" /></SelectTrigger>
                              <SelectContent className="max-h-64">
                                {DOC_TYPE_OPTIONS.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                              </SelectContent>
                            </Select>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="document_password">Password</Label>
                            <Input id="document_password" type="text" placeholder="Document Password (if any)" value={formData.document_password}
                              onChange={e => setFormData({ ...formData, document_password: e.target.value })} data-testid="document-password-input" />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="associated_with">Associated With (Firm/Client)</Label>
                            <Input id="associated_with" placeholder="Firm or client name" value={formData.associated_with}
                              onChange={e => setFormData({ ...formData, associated_with: e.target.value })} data-testid="document-associated-input" />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label htmlFor="entity_type">Entity Type</Label>
                            <Select value={formData.entity_type} onValueChange={v => setFormData({ ...formData, entity_type: v })}>
                              <SelectTrigger id="entity_type" data-testid="document-entity-type-select"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="firm">Firm</SelectItem>
                                <SelectItem value="client">Client</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="issue_date">Issue Date <span className="text-red-500">*</span></Label>
                            <Input id="issue_date" type="date" value={formData.issue_date}
                              onChange={e => setFormData({ ...formData, issue_date: e.target.value })} required data-testid="document-issue-date-input" />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label htmlFor="notes">Notes</Label>
                          <Textarea id="notes" placeholder="Additional notes" value={formData.notes}
                            onChange={e => setFormData({ ...formData, notes: e.target.value })} rows={2} data-testid="document-notes-input" />
                        </div>
                        <DialogFooter>
                          <Button type="button" variant="outline" onClick={() => { setDialogOpen(false); resetForm(); }} data-testid="document-cancel-btn">Cancel</Button>
                          <Button type="submit" disabled={loading} className="bg-indigo-600 hover:bg-indigo-700" data-testid="document-submit-btn">
                            {loading ? 'Saving...' : 'Update Document'}
                          </Button>
                        </DialogFooter>
                      </form>
                    </TabsContent>

                    <TabsContent value="status" className="mt-4 space-y-4">
                      <Card className={`p-4 ${getDocumentInOutStatus(editingDocument) === 'IN' ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                        <p className="text-sm text-slate-600 mb-1">Current Status</p>
                        <div className="flex items-center gap-2">
                          {getDocumentInOutStatus(editingDocument) === 'IN'
                            ? <><ArrowDownCircle className="h-5 w-5 text-emerald-600" /><Badge className="bg-emerald-600 text-white">IN — Available</Badge></>
                            : <><ArrowUpCircle className="h-5 w-5 text-red-600" /><Badge className="bg-red-600 text-white">OUT — Taken</Badge></>}
                        </div>
                      </Card>
                      <Card className="p-4">
                        <h4 className={`font-medium mb-3 ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                          {getDocumentInOutStatus(editingDocument) === 'IN' ? 'Mark as OUT' : 'Mark as IN'}
                        </h4>
                        <form onSubmit={e => { e.preventDefault(); handleMovementInModal(); }} className="space-y-3">
                          <div className="space-y-2">
                            <Label htmlFor="inline_person">{getDocumentInOutStatus(editingDocument) === 'IN' ? 'Taken By *' : 'Delivered By *'}</Label>
                            <Input id="inline_person" placeholder="Enter person name" value={movementData.person_name}
                              onChange={e => setMovementData({ ...movementData, person_name: e.target.value })} required />
                          </div>
                          <div className="space-y-2">
                            <Label htmlFor="inline_notes">Notes</Label>
                            <Input id="inline_notes" placeholder="Optional notes" value={movementData.notes}
                              onChange={e => setMovementData({ ...movementData, notes: e.target.value })} />
                          </div>
                          <Button type="submit" disabled={loading}
                            className={getDocumentInOutStatus(editingDocument) === 'IN' ? 'bg-red-600 hover:bg-red-700 w-full' : 'bg-emerald-600 hover:bg-emerald-700 w-full'}>
                            {getDocumentInOutStatus(editingDocument) === 'IN'
                              ? <><ArrowUpCircle className="h-4 w-4 mr-2" />Mark as OUT</>
                              : <><ArrowDownCircle className="h-4 w-4 mr-2" />Mark as IN</>}
                          </Button>
                        </form>
                      </Card>
                    </TabsContent>

                    <TabsContent value="history" className="mt-4">
                      <div className="space-y-3 max-h-80 overflow-y-auto">
                        {editingDocument?.movement_log?.length > 0
                          ? editingDocument.movement_log.slice().reverse().map((movement, index) => {
                              const mKey   = movement.id || movement.timestamp;
                              const isEdit = editingMovement === mKey;
                              return (
                                <Card key={index} className={`p-3 ${movement.movement_type === 'IN' ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                                  {isEdit ? (
                                    <div className="space-y-3">
                                      <div className="flex items-center gap-3">
                                        <Label className="text-sm font-medium">Status:</Label>
                                        <div className="flex gap-2">
                                          <Button type="button" size="sm"
                                            variant={editMovementData.movement_type === 'IN' ? 'default' : 'outline'}
                                            className={editMovementData.movement_type === 'IN' ? 'bg-emerald-600 hover:bg-emerald-700' : ''}
                                            onClick={() => setEditMovementData({ ...editMovementData, movement_type: 'IN' })}>
                                            <ArrowDownCircle className="h-4 w-4 mr-1" />IN
                                          </Button>
                                          <Button type="button" size="sm"
                                            variant={editMovementData.movement_type === 'OUT' ? 'default' : 'outline'}
                                            className={editMovementData.movement_type === 'OUT' ? 'bg-red-600 hover:bg-red-700' : ''}
                                            onClick={() => setEditMovementData({ ...editMovementData, movement_type: 'OUT' })}>
                                            <ArrowUpCircle className="h-4 w-4 mr-1" />OUT
                                          </Button>
                                        </div>
                                      </div>
                                      <div className="space-y-2">
                                        <Label className="text-xs">Person Name</Label>
                                        <Input size="sm" value={editMovementData.person_name}
                                          onChange={e => setEditMovementData({ ...editMovementData, person_name: e.target.value })} placeholder="Person name" />
                                      </div>
                                      <div className="space-y-2">
                                        <Label className="text-xs">Notes</Label>
                                        <Input size="sm" value={editMovementData.notes}
                                          onChange={e => setEditMovementData({ ...editMovementData, notes: e.target.value })} placeholder="Notes (optional)" />
                                      </div>
                                      <div className="flex gap-2 justify-end">
                                        <Button type="button" size="sm" variant="outline" onClick={() => setEditingMovement(null)}>Cancel</Button>
                                        <Button type="button" size="sm" className="bg-indigo-600 hover:bg-indigo-700"
                                          onClick={() => handleUpdateMovement(movement.id)} disabled={loading || !editMovementData.person_name}>
                                          {loading ? 'Saving...' : 'Save'}
                                        </Button>
                                      </div>
                                    </div>
                                  ) : (
                                    <div className="flex items-start justify-between">
                                      <div className="flex-1">
                                        <div className="flex items-center gap-2 mb-1">
                                          <Badge className={movement.movement_type === 'IN' ? 'bg-emerald-600 text-xs' : 'bg-red-600 text-xs'}>{movement.movement_type}</Badge>
                                          <span className="text-sm font-medium">{movement.person_name}</span>
                                        </div>
                                        {movement.notes && <p className="text-xs text-slate-600">{movement.notes}</p>}
                                      </div>
                                      <div className="flex flex-col items-end gap-2">
                                        <span className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                          {format(new Date(movement.timestamp), 'MMM dd, yyyy hh:mm a')}
                                        </span>
                                        {movement.id && (
                                          <Button type="button" size="sm" variant="ghost"
                                            className="h-7 px-2 text-xs text-slate-500 hover:text-indigo-600"
                                            onClick={() => startEditingMovement(movement)}>
                                            <Edit className="h-3 w-3 mr-1" />Edit
                                          </Button>
                                        )}
                                      </div>
                                    </div>
                                  )}
                                </Card>
                              );
                            })
                          : <div className="text-center py-8 text-slate-500"><History className="h-12 w-12 mx-auto mb-3 text-slate-300" /><p>No movement history yet</p></div>
                        }
                      </div>
                    </TabsContent>
                  </Tabs>
                ) : (
                  <form onSubmit={handleSubmit} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="holder_name">Holder Name <span className="text-red-500">*</span></Label>
                        <Input id="holder_name" placeholder="Name of document holder" value={formData.holder_name}
                          onChange={e => setFormData({ ...formData, holder_name: e.target.value })} required data-testid="document-holder-name-input" />
                      </div>
                      <div className="space-y-2">
                        <Label>Document Type</Label>
                        <Select value={formData.document_type} onValueChange={v => setFormData({ ...formData, document_type: v })}>
                          <SelectTrigger id="document_type" data-testid="document-type-select"><SelectValue placeholder="Select document type" /></SelectTrigger>
                          <SelectContent className="max-h-64">
                            {DOC_TYPE_OPTIONS.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="document_password">Password</Label>
                        <Input id="document_password" type="text" placeholder="Document Password (if any)" value={formData.document_password}
                          onChange={e => setFormData({ ...formData, document_password: e.target.value })} data-testid="document-password-input" />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="associated_with">Associated With (Firm/Client)</Label>
                        <Input id="associated_with" placeholder="Firm or client name" value={formData.associated_with}
                          onChange={e => setFormData({ ...formData, associated_with: e.target.value })} data-testid="document-associated-input" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label htmlFor="entity_type">Entity Type</Label>
                        <Select value={formData.entity_type} onValueChange={v => setFormData({ ...formData, entity_type: v })}>
                          <SelectTrigger id="entity_type" data-testid="document-entity-type-select"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="firm">Firm</SelectItem>
                            <SelectItem value="client">Client</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="issue_date">Issue Date <span className="text-red-500">*</span></Label>
                        <Input id="issue_date" type="date" value={formData.issue_date}
                          onChange={e => setFormData({ ...formData, issue_date: e.target.value })} required data-testid="document-issue-date-input" />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="notes">Notes</Label>
                      <Textarea id="notes" placeholder="Additional notes" value={formData.notes}
                        onChange={e => setFormData({ ...formData, notes: e.target.value })} rows={2} data-testid="document-notes-input" />
                    </div>
                    <DialogFooter>
                      <Button type="button" variant="outline" onClick={() => { setDialogOpen(false); resetForm(); }} data-testid="document-cancel-btn">Cancel</Button>
                      <Button type="submit" disabled={loading} className="bg-indigo-600 hover:bg-indigo-700" data-testid="document-submit-btn">
                        {loading ? 'Saving...' : 'Add Document'}
                      </Button>
                    </DialogFooter>
                  </form>
                )}
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {/* ── Stats strip inside banner ── */}
        <div className="relative px-6 pb-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total IN',      value: statsIn,      icon: ArrowDownCircle, color: '#10b981' },
            { label: 'Total OUT',     value: statsOut,     icon: ArrowUpCircle,   color: '#ef4444' },
            { label: 'Total Records', value: statsTotal,   icon: FileText,        color: '#6366f1' },
            { label: 'Out > 30 days', value: statsLongOut, icon: Clock,           color: '#f97316' },
          ].map(stat => {
            const Icon = stat.icon;
            return (
              <div key={stat.label}
                className="rounded-xl backdrop-blur-sm px-4 py-3 flex items-center gap-3 cursor-default transition-all hover:scale-[1.03]"
                style={{ background: 'rgba(255,255,255,0.10)', border: '1px solid rgba(255,255,255,0.18)', backdropFilter: 'blur(8px)' }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${stat.color}30` }}>
                  <Icon className="h-4 w-4" style={{ color: stat.color }} />
                </div>
                <div>
                  <p className="text-white/50 text-[10px] font-semibold uppercase tracking-widest leading-none">{stat.label}</p>
                  <p className="text-white text-2xl font-black tabular-nums leading-tight mt-0.5" style={{ fontFamily: "'Roboto Mono', monospace" }}>{stat.value}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Page body ── */}
      <div className="px-6 py-6 space-y-5">

        {/* ── Controls bar ── */}
        <div className="flex flex-col sm:flex-row gap-3 flex-wrap items-center">
          <Select value={rowsPerPage.toString()} onValueChange={v => { setRowsPerPage(Number(v)); setCurrentPageIn(1); setCurrentPageOut(1); }}>
            <SelectTrigger className={`w-[140px] focus:border-indigo-500 ${isDark ? 'bg-slate-800 border-slate-600 text-slate-100' : 'bg-white border-slate-200'}`}>
              <SelectValue placeholder="Rows per page" />
            </SelectTrigger>
            <SelectContent>
              {[15,30,50,100].map(n => <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>)}
            </SelectContent>
          </Select>

          <div className={`flex items-center gap-2 border rounded-xl px-3 h-10 ${isDark ? 'bg-slate-800 border-slate-600' : 'bg-white border-slate-200'}`}>
            <ArrowUpDown className="h-4 w-4 text-slate-400 flex-shrink-0" />
            <div className="flex items-center gap-1">
              {SORT_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => setSortOrder(opt.value)}
                  className="px-2.5 py-1 rounded-lg text-xs font-semibold transition-all"
                  style={{ background: sortOrder === opt.value ? 'linear-gradient(135deg,#4f46e5,#6366f1)' : 'transparent', color: sortOrder === opt.value ? '#fff' : (isDark ? '#94a3b8' : '#64748b') }}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
            <Input ref={searchRef} type="text" placeholder='Search… (press "/" to focus)' value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className={`pl-10 pr-16 focus:border-indigo-500 ${isDark ? 'bg-slate-800 border-slate-600 text-slate-100 placeholder:text-slate-500' : 'bg-white border-slate-200'}`}
              data-testid="document-search-input" />
            {!searchQuery && (
              <kbd className={`absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-mono px-1.5 py-0.5 rounded border ${isDark ? 'bg-slate-700 border-slate-500 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-400'}`}>/</kbd>
            )}
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                <XCircle className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* ── Bulk action bar ── */}
        {selectedIds.size > 0 && (
          <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border ${isDark ? 'bg-indigo-900/30 border-indigo-700' : 'bg-indigo-50 border-indigo-200'}`}>
            <CheckSquare className="h-4 w-4 text-indigo-500 flex-shrink-0" />
            <span className={`text-sm font-semibold ${isDark ? 'text-indigo-300' : 'text-indigo-700'}`}>{selectedIds.size} document(s) selected</span>
            <div className="flex gap-2 ml-auto">
              <Button size="sm" onClick={() => { setBulkMovementType('IN'); setBulkDialogOpen(true); }}
                className="bg-emerald-600 hover:bg-emerald-700 text-white h-8 px-3 text-xs rounded-lg gap-1">
                <ArrowDownCircle className="h-3.5 w-3.5" />Mark all IN
              </Button>
              <Button size="sm" onClick={() => { setBulkMovementType('OUT'); setBulkDialogOpen(true); }}
                className="bg-red-600 hover:bg-red-700 text-white h-8 px-3 text-xs rounded-lg gap-1">
                <ArrowUpCircle className="h-3.5 w-3.5" />Mark all OUT
              </Button>
              <Button size="sm" variant="ghost" onClick={clearSelection}
                className={`h-8 px-3 text-xs rounded-lg ${isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'}`}>
                Clear
              </Button>
            </div>
          </div>
        )}

        {/* ── Row colour legend ── */}
        <div className="flex items-center gap-4 text-xs flex-wrap">
          <span className={`font-semibold ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>Row colours:</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-orange-200 inline-block border border-orange-300" />OUT &gt; 30 days</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded bg-yellow-100 inline-block border border-yellow-300" />OUT &gt; 7 days</span>
        </div>

        {/* ── Tabs ── */}
        <style>{`
          #root #documents-status-tabs {
            display: flex !important;
            width: 100% !important;
            min-width: 0 !important;
            gap: 0 !important;
            padding: 0 !important;
            height: 40px !important;
            min-height: 40px !important;
            border-radius: 0 !important;
            overflow: hidden !important;
          }
          #root #documents-status-tabs > [role="tab"] {
            display: flex !important;
            flex: 1 1 0% !important;
            width: 0 !important;
            min-width: 0 !important;
            max-width: none !important;
            height: 40px !important;
            min-height: 40px !important;
            padding: 0 !important;
            align-self: stretch !important;
            align-items: center !important;
            justify-content: center !important;
            text-align: center !important;
            white-space: nowrap !important;
            border-radius: 0 !important;
            margin: 0 !important;
          }
          #root #documents-status-tabs > [role="tab"] > span {
            display: flex !important;
            width: 100% !important;
            height: 100% !important;
            min-width: 0 !important;
            align-items: center !important;
            justify-content: center !important;
            text-align: center !important;
            line-height: 1.2 !important;
            gap: 6px !important;
            margin: 0 !important;
          }
          #root #documents-status-tabs > [role="tab"] > span > span {
            display: inline-flex !important;
            align-items: center !important;
            justify-content: center !important;
            text-align: center !important;
          }
        `}</style>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList id="documents-status-tabs" className={`flex w-full h-10 items-stretch rounded-none p-0 gap-0 ${isDark ? 'bg-slate-800 border border-slate-700' : 'bg-slate-100 border border-slate-200'}`}>
            {searchQuery.trim() && (
              <TabsTrigger value="all"
                className="rounded-none px-0 py-2 text-sm font-semibold transition-all data-[state=active]:bg-blue-600 data-[state=active]:text-white data-[state=active]:shadow-md">
                <span className="flex w-full items-center justify-center gap-1.5 text-center">
                  <span>🔍 All Results ({allDocuments.length})</span>
                </span>
              </TabsTrigger>
            )}
            <TabsTrigger value="in"
              className="rounded-none px-0 py-2 text-sm font-semibold transition-all data-[state=active]:bg-emerald-500 data-[state=active]:text-white data-[state=active]:shadow-md">
              <span className="flex w-full items-center justify-center gap-1.5 text-center">
                <ArrowDownCircle className="h-4 w-4 shrink-0" />
                <span>IN ({inDocuments.length})</span>
              </span>
            </TabsTrigger>
            <TabsTrigger value="out"
              className="rounded-none px-0 py-2 text-sm font-semibold transition-all data-[state=active]:bg-red-500 data-[state=active]:text-white data-[state=active]:shadow-md">
              <span className="flex w-full items-center justify-center gap-1.5 text-center">
                <ArrowUpCircle className="h-4 w-4 shrink-0" />
                <span>OUT ({outDocuments.length})</span>
              </span>
            </TabsTrigger>
          </TabsList>

          {/* ALL tab — shown only when searching */}
          <TabsContent value="all" className="mt-4">
            <div className="rounded-2xl border shadow-sm overflow-hidden flex flex-col"
              style={{ background: isDark ? '#1e293b' : '#fff', borderColor: isDark ? 'rgba(255,255,255,0.07)' : '#bfdbfe' }}>
              <div className="bg-blue-50 border-b border-blue-200 px-5 py-3 flex items-center gap-2">
                <Search className="h-4 w-4 text-blue-700 flex-shrink-0" />
                <p className="text-sm font-semibold text-blue-700 uppercase tracking-wider">All Results for "{searchQuery}" ({allDocuments.length})</p>
              </div>
              {allDocuments.length === 0
                ? <div className={`text-center py-16 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                    <Search className="h-10 w-10 mx-auto mb-3 opacity-30" />
                    <p className="font-medium">No documents found for "{searchQuery}"</p>
                  </div>
                : <DocumentTable documentList={allDocuments} onEdit={handleEdit} onDelete={handleDelete} onMovement={openMovementDialog}
                    onViewLog={openLogDialog} onShowFullNotes={openFullNotes} type="IN" isDark={isDark}
                    selectedIds={selectedIds} onToggleSelect={toggleSelect} onToggleAll={toggleAll} />
              }
            </div>
          </TabsContent>

          {/* IN */}
          <TabsContent value="in" className="mt-4">
            <div className="rounded-2xl border shadow-sm overflow-hidden flex flex-col"
              style={{ background: isDark ? '#1e293b' : '#fff', borderColor: isDark ? 'rgba(255,255,255,0.07)' : '#d1fae5' }}>
              <div className="bg-emerald-50 border-b border-emerald-200 px-5 py-3 flex items-center gap-2">
                <ArrowDownCircle className="h-4 w-4 text-emerald-700 flex-shrink-0" />
                <p className="text-sm font-semibold text-emerald-700 uppercase tracking-wider">Documents IN — Available ({inDocuments.length})</p>
              </div>
              {loading && inDocuments.length === 0
                ? <MiniLoader />
                : inDocuments.length === 0
                  ? <div className={`text-center py-16 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      <ArrowDownCircle className="h-10 w-10 mx-auto mb-3 opacity-30" />
                      <p className="font-medium">No documents currently IN</p>
                    </div>
                  : <DocumentTable documentList={pagedIn} onEdit={handleEdit} onDelete={handleDelete} onMovement={openMovementDialog}
                      onViewLog={openLogDialog} onShowFullNotes={openFullNotes} type="IN" isDark={isDark}
                      selectedIds={selectedIds} onToggleSelect={toggleSelect} onToggleAll={toggleAll} />
              }
              <PaginationBar currentPage={spIn} totalPages={tpIn} totalItems={inDocuments.length} pageSize={rowsPerPage} onPageChange={setCurrentPageIn} isDark={isDark} />
            </div>
          </TabsContent>

          {/* OUT */}
          <TabsContent value="out" className="mt-4">
            <div className="rounded-2xl border shadow-sm overflow-hidden flex flex-col"
              style={{ background: isDark ? '#1e293b' : '#fff', borderColor: isDark ? 'rgba(255,255,255,0.07)' : '#fecaca' }}>
              <div className="bg-red-50 border-b border-red-200 px-5 py-3 flex items-center gap-2">
                <ArrowUpCircle className="h-4 w-4 text-red-700 flex-shrink-0" />
                <p className="text-sm font-semibold text-red-700 uppercase tracking-wider">Documents OUT — Taken ({outDocuments.length})</p>
              </div>
              {loading && outDocuments.length === 0
                ? <MiniLoader />
                : outDocuments.length === 0
                  ? <div className={`text-center py-16 ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>
                      <ArrowUpCircle className="h-10 w-10 mx-auto mb-3 opacity-30" />
                      <p className="font-medium">No documents currently OUT</p>
                    </div>
                  : <DocumentTable documentList={pagedOut} onEdit={handleEdit} onDelete={handleDelete} onMovement={openMovementDialog}
                      onViewLog={openLogDialog} onShowFullNotes={openFullNotes} type="OUT" isDark={isDark}
                      selectedIds={selectedIds} onToggleSelect={toggleSelect} onToggleAll={toggleAll} />
              }
              <PaginationBar currentPage={spOut} totalPages={tpOut} totalItems={outDocuments.length} pageSize={rowsPerPage} onPageChange={setCurrentPageOut} isDark={isDark} />
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* ── Bulk Movement Dialog ── */}
      <Dialog open={bulkDialogOpen} onOpenChange={open => { setBulkDialogOpen(open); if (!open) { setBulkPersonName(''); setBulkNotes(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-outfit text-2xl">Bulk Mark as {bulkMovementType}</DialogTitle>
            <DialogDescription>{selectedIds.size} document(s) selected will be marked as {bulkMovementType}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>{bulkMovementType === 'IN' ? 'Delivered By *' : 'Taken By *'}</Label>
              <Input placeholder="Enter person name" value={bulkPersonName} onChange={e => setBulkPersonName(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea placeholder="Additional notes" value={bulkNotes} onChange={e => setBulkNotes(e.target.value)} rows={2} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDialogOpen(false)}>Cancel</Button>
            <Button disabled={bulkLoading || !bulkPersonName.trim()} onClick={handleBulkMovement}
              className={bulkMovementType === 'IN' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}>
              {bulkLoading ? 'Processing...' : `Mark ${selectedIds.size} as ${bulkMovementType}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Single Movement Dialog ── */}
      <Dialog open={movementDialogOpen} onOpenChange={setMovementDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="font-outfit text-2xl">Mark Document as {movementData.movement_type}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleMovement} className="space-y-4">
            <div className="space-y-2">
              <Label>Document</Label>
              <p className="text-sm font-semibold">{selectedDocument?.holder_name || '—'}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="person_name">{movementData.movement_type === 'IN' ? 'Delivered By *' : 'Taken By *'}</Label>
              <Input id="person_name" placeholder="Enter person name" value={movementData.person_name}
                onChange={e => setMovementData({ ...movementData, person_name: e.target.value })} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="movement_notes">Notes</Label>
              <Textarea id="movement_notes" placeholder="Additional notes" value={movementData.notes}
                onChange={e => setMovementData({ ...movementData, notes: e.target.value })} rows={2} />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setMovementDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={loading}
                className={movementData.movement_type === 'IN' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-red-600 hover:bg-red-700'}>
                {loading ? 'Recording...' : `Mark as ${movementData.movement_type}`}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ── Log Dialog ── */}
     <Dialog open={logDialogOpen} onOpenChange={setLogDialogOpen}>
        <DialogContent className="max-w-xl p-0 border-none bg-transparent shadow-none overflow-visible">
          <DialogHeader className="sr-only">
            <DialogTitle>Document Details — {selectedDocument?.holder_name}</DialogTitle>
          </DialogHeader>

          <div ref={shareAreaRef} className={`rounded-2xl overflow-hidden border shadow-2xl ${isDark ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-slate-200 text-slate-900'}`}>
            {/* Header strip — dark navy with icon tile */}
            <div className="relative px-6 py-5" style={{ background: 'linear-gradient(135deg,#0D3B66,#1F6FB2)' }}>
              <div className="flex items-center gap-3">
                <div className="h-11 w-11 rounded-xl bg-white/10 flex items-center justify-center backdrop-blur">
                  <FileText className="h-5 w-5 text-white" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-bold tracking-[0.18em] text-white/60 uppercase">Document Details</p>
                  <h2 className="text-xl font-bold text-white truncate">{selectedDocument?.holder_name || '—'}</h2>
                </div>
              </div>
            </div>

            {/* Body */}
            <div className="p-6 space-y-4">
              {/* Status pills */}
              <div className="flex flex-wrap gap-2">
                <span className={`text-[11px] font-semibold px-3 py-1 rounded-full ${getDocumentInOutStatus(selectedDocument) === 'IN' ? 'bg-emerald-50 text-emerald-600' : 'bg-orange-50 text-orange-600'}`}>
                  {getDocumentInOutStatus(selectedDocument) === 'IN' ? 'Available' : 'Out'}
                </span>
                {selectedDocument?.document_type && (
                  <span className="text-[11px] font-semibold px-3 py-1 rounded-full bg-rose-50 text-rose-600 capitalize">
                    {selectedDocument.document_type}
                  </span>
                )}
                {selectedDocument?.status && (
                  <span className="text-[11px] font-semibold px-3 py-1 rounded-full bg-indigo-50 text-indigo-600 capitalize">
                    {selectedDocument.status}
                  </span>
                )}
              </div>

              {/* Description / Notes */}
              <div>
                <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase mb-1.5">Description</p>
                <div className={`rounded-lg px-3 py-2.5 text-sm font-semibold capitalize ${isDark ? 'bg-slate-800/60' : 'bg-slate-50'}`}>
                  {selectedDocument?.notes || 'No additional notes provided.'}
                </div>
              </div>

              {/* Meta rows with icons */}
              <div className="space-y-3 pt-1">
                <div className="flex items-start gap-3">
                  <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                    <FileText className="h-3.5 w-3.5 text-slate-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Document Holder</p>
                    <p className="text-sm font-semibold capitalize">{selectedDocument?.holder_name || '—'}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                    <FileText className="h-3.5 w-3.5 text-slate-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Reference / Password</p>
                    <p className="text-sm font-mono">{selectedDocument?.document_password || 'NONE'}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                    <Clock className="h-3.5 w-3.5 text-slate-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Issue Date</p>
                    <p className="text-sm font-semibold">{selectedDocument?.issue_date ? format(new Date(selectedDocument.issue_date), 'dd MMM, yyyy') : '—'}</p>
                  </div>
                </div>
                {selectedDocument?.movement_log?.length > 0 && (
                  <div className="flex items-start gap-3">
                    <div className={`h-7 w-7 rounded-md flex items-center justify-center mt-0.5 ${isDark ? 'bg-slate-800' : 'bg-slate-100'}`}>
                      <History className="h-3.5 w-3.5 text-slate-500" />
                    </div>
                    <div className="flex-1">
                      <p className="text-[10px] font-bold tracking-[0.15em] text-slate-400 uppercase">Last Movement</p>
                      {(() => {
                        const m = selectedDocument.movement_log[selectedDocument.movement_log.length - 1];
                        return (
                          <p className="text-sm font-semibold">
                            <span className={m.movement_type === 'IN' ? 'text-emerald-600' : 'text-red-500'}>{m.movement_type}</span>
                            {' '}· {m.person_name} · {format(new Date(m.timestamp), 'dd MMM, hh:mm a')}
                          </p>
                        );
                      })()}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Footer action buttons */}
            <div className={`px-6 py-4 border-t flex gap-2 print:hidden ${isDark ? 'border-slate-700 bg-slate-900/50' : 'border-slate-100 bg-slate-50/50'}`}>
              <Button size="sm" variant="outline" onClick={() => handleShare('whatsapp')} className="flex-1 gap-1.5 text-emerald-600 border-emerald-200 hover:bg-emerald-50">
                <MessageCircle className="h-3.5 w-3.5" />
                WhatsApp
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleShare('download')} className="flex-1 gap-1.5 text-slate-700 border-slate-200 hover:bg-slate-100">
                <Download className="h-3.5 w-3.5" />
                Screenshot
              </Button>
              <Button size="sm" variant="outline" onClick={() => handleShare('email')} className="gap-1.5 text-blue-600 border-blue-200 hover:bg-blue-50">
                <Mail className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Full Notes Modal ── */}
      <Dialog open={fullNotesOpen} onOpenChange={setFullNotesOpen}>
        <DialogContent className="sm:max-w-lg max-h-[85vh]">
          <DialogHeader><DialogTitle className="font-outfit">Notes — {selectedFullNotes.holder_name}</DialogTitle></DialogHeader>
          <div className={`mt-4 p-5 rounded-xl border max-h-[65vh] overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed ${isDark ? 'bg-slate-700 border-slate-600 text-slate-200' : 'bg-slate-50 border-slate-200'}`}>
            {selectedFullNotes.notes || <p className={`italic text-center py-10 ${isDark ? 'text-slate-600' : 'text-slate-400'}`}>No notes available</p>}
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setFullNotesOpen(false)}>Close</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── AI Duplicate Detection Dialog ─────────────────────────────── */}
      <AIDuplicateDialog
        open={showDupDialog}
        onClose={() => setShowDupDialog(false)}
        groups={dupGroups}
        items={documentList}
        entityLabel="Document"
        accentColor="#0f766e"
        isDark={isDark}
        canDelete={canDeleteDoc}
        canEdit={canEditDoc}
        getTitle={(d) => d.holder_name || 'Unknown Holder'}
        getSubtitle={(d) => [d.document_type, d.document_number || d.reference_no].filter(Boolean).join(' · ') || null}
        getMeta={(d) => [
          d.document_type ? d.document_type.toUpperCase() : null,
          d.status        ? d.status.toUpperCase()        : null,
          d.pan           ? `PAN: ${d.pan}`               : null,
          d.expiry_date   ? `Exp: ${format(new Date(d.expiry_date), 'MMM yyyy')}` : null,
        ].filter(Boolean)}
        compareFields={(a, b) => [
          { label: 'Holder',       a: a.holder_name,                  b: b.holder_name },
          { label: 'Doc Type',     a: a.document_type,                b: b.document_type },
          { label: 'Doc No.',      a: a.document_number || a.reference_no, b: b.document_number || b.reference_no },
          { label: 'PAN',          a: a.pan,                          b: b.pan },
          { label: 'Status',       a: a.status,                       b: b.status },
          { label: 'Expiry',       a: a.expiry_date ? format(new Date(a.expiry_date), 'MMM dd, yyyy') : '—', b: b.expiry_date ? format(new Date(b.expiry_date), 'MMM dd, yyyy') : '—' },
          { label: 'Notes',        a: (a.notes || '—').slice(0, 60),  b: (b.notes || '—').slice(0, 60) },
        ]}
        onEdit={(d) => { handleEdit(d); setShowDupDialog(false); }}
        onDelete={async (d) => {
          if (!window.confirm(`Delete document for "${d.holder_name}"?`)) return;
          try {
            await api.delete(`/documents/${d.id}`);
            setDocumentList((prev) => prev.filter((x) => x.id !== d.id));
            toast.success('Document deleted');
          } catch { toast.error('Failed to delete document'); }
        }}
        onView={(d) => { setSelectedDocument(d); setLogDialogOpen(true); setShowDupDialog(false); }}
      />
    </div>
  );
}
