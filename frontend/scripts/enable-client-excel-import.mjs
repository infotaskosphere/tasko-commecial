import fs from 'node:fs';
import path from 'node:path';

const componentPath = path.resolve('src/components/MasterDataClientManager.jsx');
let source = fs.readFileSync(componentPath, 'utf8');

if (!source.includes("import * as XLSX from 'xlsx';")) {
  source = source.replace(
    "import api from '@/lib/api';",
    "import * as XLSX from 'xlsx';\nimport api from '@/lib/api';",
  );
}

source = source.replace('accept=".csv"', 'accept=".csv,.xlsx,.xls"');

if (!source.includes("XLSX.read(buffer,{type:'array'})")) {
  const handler = [
    " const handleImportCSV=async(e)=>{",
    "  const file=e.target.files?.[0];",
    "  if(!file)return;",
    "  setImporting(true);",
    "  try{",
    "   let uploadFile=file;",
    "   const isExcel=/\\.(xlsx|xls)$/i.test(file.name||'');",
    "   if(isExcel){",
    "    const buffer=await file.arrayBuffer();",
    "    const workbook=XLSX.read(buffer,{type:'array'});",
    "    const sheetName=workbook.SheetNames?.[0];",
    "    if(!sheetName)throw new Error('Excel workbook has no worksheets');",
    "    const sheet=workbook.Sheets[sheetName];",
    "    const rows=XLSX.utils.sheet_to_json(sheet,{defval:'',raw:false});",
    "    const normalizeHeader=value=>String(value??'').trim().toLowerCase().replace(/[\\s./()-]+/g,'_').replace(/_+/g,'_');",
    "    const valueFor=(row,names)=>{const aliases=new Set(names.map(normalizeHeader));const key=Object.keys(row).find(k=>aliases.has(normalizeHeader(k)));return key==null?'':row[key]};",
    "    const normalizeType=value=>{const t=String(value||'proprietor').trim().toLowerCase().replace(/[\\s-]+/g,'_');return ({proprietorship:'proprietor',proprietor:'proprietor',private_limited:'pvt_ltd',private_limited_company:'pvt_ltd',pvt_ltd:'pvt_ltd',limited_liability_partnership:'llp',llp:'llp',public_limited:'public_ltd',public_limited_company:'public_ltd',section_8_company:'section_8',partnership:'partnership',huf:'huf',trust:'trust',other:'other'})[t]||'other'};",
    "    const expected=['company_name','client_type','email','phone','birthday','address','city','state','services','notes','assigned_to','status'];",
    "    const normalized=rows.map(row=>({company_name:String(valueFor(row,['company_name','company','client_name','business_name','name'])).trim(),client_type:normalizeType(valueFor(row,['client_type','type','constitution'])),email:String(valueFor(row,['email','email_address'])).trim(),phone:String(valueFor(row,['phone','mobile','mobile_no','phone_number'])).trim(),birthday:String(valueFor(row,['birthday','birth_date','dob'])).trim(),address:String(valueFor(row,['address','registered_address'])).trim(),city:String(valueFor(row,['city'])).trim(),state:String(valueFor(row,['state'])).trim(),services:String(valueFor(row,['services','service'])).replace(/;/g,',').trim(),notes:String(valueFor(row,['notes','remarks','comment','comments'])).trim(),assigned_to:String(valueFor(row,['assigned_to','assigned_to_user','assignee'])).trim(),status:String(valueFor(row,['status'])).trim().toLowerCase()||'active'})).filter(row=>row.company_name);",
    "    const csvSheet=XLSX.utils.json_to_sheet(normalized,{header:expected});",
    "    const csv=XLSX.utils.sheet_to_csv(csvSheet);",
    "    const baseName=file.name.replace(/\\.[^.]+$/,'');",
    "    uploadFile=new File([String.fromCharCode(0xFEFF)+csv],baseName+'.csv',{type:'text/csv;charset=utf-8'});",
    "   }",
    "   const fd=new FormData();",
    "   fd.append('file',uploadFile);",
    "   const r=await api.post('/clients/import',fd,{headers:{'Content-Type':'multipart/form-data'}});",
    "   const created=Number(r.data?.clients_created||0);",
    "   const skipped=Number(r.data?.clients_skipped||0);",
    "   toast.success(r.data?.message||String(created)+' clients imported'+(skipped?', '+String(skipped)+' skipped':''));",
    "   if(r.data?.errors?.length)console.warn('[Client Import] skipped rows:',r.data.errors);",
    "   await load();",
    "  }catch(err){toast.error(err?.response?.data?.detail||err?.message||'Import failed')}finally{setImporting(false);e.target.value=''}",
    " };",
  ].join('\n');

  const handlerPattern = / const handleImportCSV=async\(e\)=>\{[\s\S]*?\};\n return <section/;
  if (handlerPattern.test(source)) {
    source = source.replace(handlerPattern, () => `${handler}\n return <section`);
  }
}

fs.writeFileSync(componentPath, source, 'utf8');
console.log('Client bulk import: CSV + XLSX/XLS support enabled.');
