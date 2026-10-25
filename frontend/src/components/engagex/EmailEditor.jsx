// MailMaster email editor: visual (contentEditable) + HTML modes with a live,
// sandboxed desktop/mobile preview. Content is merged server-side per recipient.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  AlignCenter, AlignLeft, Bold, Code2, Eye, Heading1, Heading2, ImageIcon, ImagePlus, Italic, Link2, List, ListOrdered, Loader2,
  Minus, Monitor, MousePointerClick, Pilcrow, RemoveFormatting, Smartphone, Underline,
} from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { MERGE_TAGS, renderMergePreview } from './shared';

export const STARTER_TEMPLATES = [
  {
    id: 'blank',
    name: 'Blank',
    subject: '',
    html: '<p>Hi {{first_name|there}},</p><p></p><p>Regards,<br>{{sender_company}}</p>',
  },
  {
    id: 'newsletter',
    name: 'Monthly newsletter',
    subject: '{{sender_company}} — this month’s updates',
    html: `<h1 style="margin:0 0 12px;font-size:24px;color:#0f172a">This month at {{sender_company}}</h1>
<p>Hi {{first_name|there}},</p>
<p>Here is a quick round-up of what changed this month and what it means for you.</p>
<h2 style="margin:24px 0 8px;font-size:18px;color:#0f172a">What’s new</h2>
<ul><li>Key regulatory update and how it affects you</li><li>Upcoming due dates you should plan for</li><li>A new service we now offer</li></ul>
<h2 style="margin:24px 0 8px;font-size:18px;color:#0f172a">Upcoming due dates</h2>
<p>Share your documents a few days early so we can file on time without penalties.</p>
<p style="margin:28px 0"><a href="https://example.com" style="display:inline-block;background:#0E9F8A;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Book a call</a></p>
<p>Regards,<br>{{sender_company}}</p>`,
  },
  {
    id: 'due-date',
    name: 'Due-date reminder',
    subject: 'Reminder: upcoming filing due date',
    html: `<p>Dear {{name|Sir/Madam}},</p>
<p>This is a friendly reminder that your next filing is due soon. To file on time, please share the following documents with us:</p>
<ol><li>Sales and purchase invoices for the period</li><li>Bank statements</li><li>Any other notices or correspondence received</li></ol>
<p>If you have already shared them, please ignore this email.</p>
<p>Warm regards,<br><strong>{{sender_company}}</strong></p>`,
  },
  {
    id: 'announcement',
    name: 'Announcement',
    subject: 'An update from {{sender_company}}',
    html: `<p style="font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#0E9F8A;margin:0 0 8px"><strong>Announcement</strong></p>
<h1 style="margin:0 0 16px;font-size:26px;color:#0f172a">We have some news to share</h1>
<p>Hi {{first_name|there}},</p>
<p>Write your announcement here. Keep it short and lead with what matters most to the reader.</p>
<p style="margin:28px 0"><a href="https://example.com" style="display:inline-block;background:#0f172a;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">Learn more</a></p>
<p>Thank you,<br>{{sender_company}}</p>`,
  },
  {
    id: 'festive',
    name: 'Festive greeting',
    subject: 'Season’s greetings from {{sender_company}}',
    html: `<div style="text-align:center"><p style="font-size:44px;margin:0">🪔</p>
<h1 style="margin:8px 0 12px;font-size:26px;color:#0f172a">Warm wishes, {{first_name|friend}}!</h1>
<p>Thank you for trusting {{sender_company}}. Wishing you and your family a joyful festive season and a prosperous year ahead.</p>
<p style="color:#64748b">— Team {{sender_company}}</p></div>`,
  },
];

const BUTTON_HTML = (text, url) =>
  `<p style="margin:24px 0"><a href="${url}" style="display:inline-block;background:#0E9F8A;color:#ffffff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${text}</a></p>`;

const escapeAttr = (v) => String(v || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Client-side approximation of backend build_email_html, for preview only. */
const bannerPreview = (banner) => {
  if (!banner?.url) return '';
  const img = `<img src="${escapeAttr(banner.url)}" alt="${escapeAttr(banner.alt || '')}" style="display:block;width:100%;height:auto;border:0" />`;
  return `<div style="line-height:0">${banner.link ? `<a href="${escapeAttr(banner.link)}">${img}</a>` : img}</div>`;
};

export function previewDocument(html, { previewText = '', footerCompany = '', footerAddress = '', banner = null } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;background:#f1f5f9;font:15px/1.65 Arial,Helvetica,sans-serif;color:#0f172a}a{color:#0E9F8A}img{max-width:100%;height:auto}</style></head>
<body><div style="display:none">${previewText}</div><div style="padding:20px 10px"><div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">${bannerPreview(banner)}<div style="padding:32px">${html || '<p style="color:#94a3b8">Your content will appear here.</p>'}</div></div>
<div style="max-width:640px;margin:0 auto;padding:18px 12px;text-align:center;font-size:12px;color:#64748b">Sent by ${footerCompany}${footerAddress ? `<br>${footerAddress}` : ''}<br>You received this email because you are in contact with ${footerCompany}.<br><u>Unsubscribe</u></div></div></body></html>`;
}

function ToolButton({ icon: Icon, label, onClick, active }) {
  return (
    <button type="button" title={label} aria-label={label} onMouseDown={(e) => e.preventDefault()} onClick={onClick}
      className={`rounded-md p-1.5 transition-colors ${active ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700'}`}>
      <Icon className="h-4 w-4" />
    </button>
  );
}

export default function EmailEditor({ value, onChange, previewVars = {}, previewText = '', footerCompany = '', footerAddress = '', height = 420, banner = null, onUploadImage = null }) {
  const [mode, setMode] = useState('visual');
  const [uploading, setUploading] = useState(false);
  const imageInputRef = useRef(null);
  const savedRange = useRef(null);
  const [device, setDevice] = useState('desktop');
  const editorRef = useRef(null);
  const lastEmitted = useRef(null);

  // Sync external value into the editable surface without fighting the caret.
  useEffect(() => {
    if (mode !== 'visual' || !editorRef.current) return;
    if (value !== lastEmitted.current && editorRef.current.innerHTML !== value) {
      editorRef.current.innerHTML = value || '';
      lastEmitted.current = value;
    }
  }, [value, mode]);

  const emit = () => {
    const html = editorRef.current?.innerHTML || '';
    lastEmitted.current = html;
    onChange(html);
  };

  const exec = (command, arg = null) => {
    editorRef.current?.focus();
    document.execCommand(command, false, arg);
    emit();
  };

  const insertHtml = (html) => exec('insertHTML', html);

  // Remember the caret so an uploaded image lands where the user clicked.
  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && editorRef.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
  };
  const restoreSelection = () => {
    const sel = window.getSelection();
    editorRef.current?.focus();
    if (savedRange.current && sel) { sel.removeAllRanges(); sel.addRange(savedRange.current); }
  };
  const uploadImage = async (file) => {
    if (!file || !onUploadImage) return;
    setUploading(true);
    try {
      const url = await onUploadImage(file);
      restoreSelection();
      insertHtml(`<p><img src="${escapeAttr(url)}" alt="" style="max-width:100%;height:auto;border-radius:8px" /></p>`);
    } catch (error) {
      toast.error(error?.message || 'Image upload failed');
    } finally {
      setUploading(false);
    }
  };

  const actions = [
    { icon: Bold, label: 'Bold', run: () => exec('bold') },
    { icon: Italic, label: 'Italic', run: () => exec('italic') },
    { icon: Underline, label: 'Underline', run: () => exec('underline') },
    { icon: Heading1, label: 'Heading', run: () => exec('formatBlock', '<h1>') },
    { icon: Heading2, label: 'Sub-heading', run: () => exec('formatBlock', '<h2>') },
    { icon: Pilcrow, label: 'Paragraph', run: () => exec('formatBlock', '<p>') },
    { icon: List, label: 'Bulleted list', run: () => exec('insertUnorderedList') },
    { icon: ListOrdered, label: 'Numbered list', run: () => exec('insertOrderedList') },
    { icon: AlignLeft, label: 'Align left', run: () => exec('justifyLeft') },
    { icon: AlignCenter, label: 'Align centre', run: () => exec('justifyCenter') },
    {
      icon: Link2, label: 'Link', run: () => {
        const url = window.prompt('Link URL (https://…)');
        if (url) exec('createLink', /^(https?:|mailto:|tel:)/i.test(url) ? url : `https://${url}`);
      },
    },
    {
      icon: MousePointerClick, label: 'Button', run: () => {
        const text = window.prompt('Button text', 'Learn more');
        if (!text) return;
        const url = window.prompt('Button link (https://…)', 'https://');
        if (url) insertHtml(BUTTON_HTML(escapeAttr(text), escapeAttr(/^(https?:|mailto:|tel:)/i.test(url) ? url : `https://${url}`)));
      },
    },
    ...(onUploadImage ? [{ icon: uploading ? Loader2 : ImagePlus, label: 'Upload image', run: () => { saveSelection(); imageInputRef.current?.click(); } }] : []),
    {
      icon: ImageIcon, label: 'Image from URL', run: () => {
        const url = window.prompt('Image URL (https://…) — use a publicly hosted image');
        if (url && /^https?:\/\//i.test(url)) insertHtml(`<p><img src="${escapeAttr(url)}" alt="" style="max-width:100%;height:auto;border-radius:8px" /></p>`);
      },
    },
    { icon: Minus, label: 'Divider', run: () => insertHtml('<hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0" />') },
    { icon: RemoveFormatting, label: 'Clear formatting', run: () => exec('removeFormat') },
  ];

  const srcDoc = useMemo(() => previewDocument(
    renderMergePreview(value, previewVars),
    { previewText: renderMergePreview(previewText, previewVars), footerCompany, footerAddress, banner },
  ), [value, previewVars, previewText, footerCompany, footerAddress, banner]);

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => { uploadImage(e.target.files?.[0]); e.target.value = ''; }} />
      <div className="min-w-0 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
        <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-slate-50 px-2 py-1.5 dark:border-slate-700 dark:bg-slate-800/60">
          <div className="mr-1 flex rounded-md border border-slate-200 bg-white p-0.5 dark:border-slate-600 dark:bg-slate-800">
            <button type="button" onClick={() => setMode('visual')} className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold ${mode === 'visual' ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500'}`}><Eye className="h-3 w-3" />Visual</button>
            <button type="button" onClick={() => setMode('html')} className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-semibold ${mode === 'html' ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-500'}`}><Code2 className="h-3 w-3" />HTML</button>
          </div>
          {mode === 'visual' && actions.map((a) => <ToolButton key={a.label} icon={a.icon} label={a.label} onClick={a.run} />)}
          {mode === 'visual' && (
            <select
              className="ml-auto h-7 rounded-md border border-slate-200 bg-white px-1.5 text-[11px] text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300"
              value=""
              onMouseDown={() => editorRef.current?.focus()}
              onChange={(e) => { if (e.target.value) exec('insertText', `{{${e.target.value}}}`); e.target.value = ''; }}
              aria-label="Insert personalisation"
            >
              <option value="">+ Personalise</option>
              {MERGE_TAGS.map((t) => <option key={t.tag} value={t.tag}>{t.label}</option>)}
            </select>
          )}
        </div>
        {mode === 'visual' ? (
          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={emit}
            onBlur={emit}
            className="max-w-none overflow-y-auto bg-white px-5 py-4 text-[15px] leading-relaxed text-slate-800 outline-none dark:bg-slate-900 dark:text-slate-100 [&_a]:text-teal-700 [&_a]:underline [&_h1]:mb-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-5 [&_h2]:text-lg [&_h2]:font-bold [&_p]:my-2.5 [&_ul]:my-2.5 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-2.5 [&_ol]:list-decimal [&_ol]:pl-6 [&_img]:max-w-full [&_hr]:my-5"
            style={{ height }}
          />
        ) : (
          <Textarea value={value} onChange={(e) => onChange(e.target.value)} className="rounded-none border-0 font-mono text-xs focus-visible:ring-0" style={{ height }} spellCheck={false} />
        )}
      </div>

      <div className="min-w-0 overflow-hidden rounded-xl border border-slate-200 dark:border-slate-700">
        <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-3 py-1.5 dark:border-slate-700 dark:bg-slate-800/60">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Preview</span>
          <div className="flex gap-1">
            <ToolButton icon={Monitor} label="Desktop" active={device === 'desktop'} onClick={() => setDevice('desktop')} />
            <ToolButton icon={Smartphone} label="Mobile" active={device === 'mobile'} onClick={() => setDevice('mobile')} />
          </div>
        </div>
        <div className="flex justify-center bg-slate-100 dark:bg-slate-900/60" style={{ height }}>
          <iframe title="Email preview" sandbox="" srcDoc={srcDoc} className="h-full border-0 bg-white transition-all" style={{ width: device === 'mobile' ? 375 : '100%' }} />
        </div>
      </div>
    </div>
  );
}
