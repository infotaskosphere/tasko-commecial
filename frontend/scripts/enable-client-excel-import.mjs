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

if (!source.includes('XLSX.read(buffer, { type: \'array\' })')) {
  const handler = ` const handleImportCSV=async(e)=>{\n  const file=e.target.files?.[0];\n  if(!file)return;\n  setImporting(true);\n  try{\n   let uploadFile=file;\n   const isExcel=/\\.(xlsx|xls)$/i.test(file.name||'');\n   if(isExcel){\n    const buffer=await file.arrayBuffer();\n    const workbook=XLSX.read(buffer,{type:'array'});\n    const sheetName=workbook.SheetNames?.[0];\n    if(!sheetName)throw new Error('Excel workbook has no worksheets');\n    const sheet=workbook.Sheets[sheetName];\n    const rows=XLSX.utils.sheet_to_json(sheet,{defval:'',raw:false});\n    const normalizeHeader=value=>String(value??'').trim().toLowerCase().replace(/[\\s./()-]+/g,'_').replace(/_+/g,'_');\n    const valueFor=(row,names)=>{\n     const aliases=new Set(names.map(normalizeHeader));\n     const key=Object.keys(row).find(k=>aliases.has(normalizeHeader(k)));\n     return key==null?'':row[key];\n    };\n    const normalizeType=value=>{\n     const t=String(value||'proprietor').trim().toLowerCase().replace(/[\\s-]+/g,'_');\n     return ({proprietorship:'proprietor',proprietor:'proprietor',private_limited:'pvt_ltd',private_limited_company:'pvt_ltd',pvt_ltd:'pvt_ltd',limited_liability_partnership:'llp',llp:'llp',public_limited:'public_ltd',public_limited_company:'public_ltd',section_8_company:'section_8',partnership:'partnership',huf:'huf',trust:'trust',other:'other'})[t]||'other';\n    };\n    const expected=['company_name','client_type','email','phone','birthday','address','city','state','services','notes','assigned_to','status'];\n    const normalized=rows.map(row=>({\n     company_name:String(valueFor(row,['company_name','company','client_name','business_name','name'])).trim(),\n     client_type:normalizeType(valueFor(row,['client_type','type','constitution'])),\n     email:String(valueFor(row,['email','email_address'])).trim(),\n     phone:String(valueFor(row,['phone','mobile','mobile_no','phone_number'])).trim(),\n     birthday:String(valueFor(row,['birthday','birth_date','dob'])).trim(),\n     address:String(valueFor(row,['address','registered_address'])).trim(),\n     city:String(valueFor(row,['city'])).trim(),\n     state:String(valueFor(row,['state'])).trim(),\n     services:String(valueFor(row,['services','service'])).replace(/;/g,',').trim(),\n     notes:String(valueFor(row,['notes','remarks','comment','comments'])).trim(),\n     assigned_to:String(valueFor(row,['assigned_to','assigned_to_user','assignee'])).trim(),\n     status:String(valueFor(row,['status'])).trim().toLowerCase()||'active',\n    })).filter(row=>row.company_name);\n    const csvSheet=XLSX.utils.json_to_sheet(normalized,{header:expected});\n    const csv=XLSX.utils.sheet_to_csv(csvSheet);\n    uploadFile=new File([`\\uFEFF\${csv}`],`\${file.name.replace(/\\.[^.]+$/,'')}.csv`,{type:'text/csv;charset=utf-8'});\n   }\n   const fd=new FormData();\n   fd.append('file',uploadFile);\n   const r=await api.post('/clients/import',fd,{headers:{'Content-Type':'multipart/form-data'}});\n   const created=Number(r.data?.clients_created||0);\n   const skipped=Number(r.data?.clients_skipped||0);\n   toast.success(r.data?.message||String(created)+' clients imported'+(skipped?', '+String(skipped)+' skipped':''));\n   if(r.data?.errors?.length)console.warn('[Client Import] skipped rows:',r.data.errors);\n   await load();\n  }catch(err){toast.error(err?.response?.data?.detail||err?.message||'Import failed')}finally{setImporting(false);e.target.value=''}\n };`;
  source = source.replace(/ const handleImportCSV=async\(e\)=>\{[\s\S]*?\};\n return <section/, `${handler}\n return <section`);
}

fs.writeFileSync(componentPath, source, 'utf8');
console.log('Client bulk import: CSV + XLSX/XLS support enabled.');
