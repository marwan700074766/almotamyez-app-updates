const { app, BrowserWindow, ipcMain, dialog, shell, powerMonitor, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');
const { query, connect, configure, getConfig } = require('./database');
const { execute } = require('./operations');
const XLSX = require('xlsx');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const { createVisualSheetsDesignerTemplate, upgradeVisualSheetsDesignerTemplate, readVisualSheetsDesignerDesign } = require('./sheets-visual-design');
const { compareVersions, fetchManifest, isHttpsUrl, downloadAndVerify } = require('./update-service');
const dataDir = path.join(app.getPath('userData'), 'data');
const settingsPath = path.join(dataDir, 'settings.json');
const driveClientPath = path.join(dataDir, 'google-drive-client.json');
const driveTokenPath = path.join(dataDir, 'google-drive-token.json');
const printLogoPath = path.join(dataDir, 'print-logo');
const customFontsDir = path.join(dataDir, 'custom-fonts');
const printTemplatesDir = path.join(dataDir, 'print-templates');
const printReferencesDir = path.join(dataDir, 'print-references');
const uiButtonIconsDir = path.join(dataDir, 'ui-button-icons');
const uiStudioSnapshotsDir = path.join(dataDir, 'ui-studio-snapshots');
const automaticBackupsDir = path.join(dataDir, 'automatic-backups');
const backupStatePath = path.join(dataDir, 'backup-state.json');
const recoveryMailPath = path.join(dataDir, 'recovery-email.json');
const updatesDownloadDir = path.join(dataDir, 'updates');
const updateInstallLogPath = path.join(updatesDownloadDir, 'install.log');
const connectionSettingsUnlocks = new Map();
const connectionSettingsUnlockDurationMs = 5 * 60 * 1000;
const adminMenuUnlocks = new Map();
const adminMenuUnlockDurationMs = 5 * 60 * 1000;
const protectedAdminViews = new Set(['layout-controls','window-designer','print-settings','print-designer','sheets-designer','import-export','data-analysis','cashboxes','cashbox-inventory','cheques','settings','backup-center','shortcut-manager','user-access','groups','device-access','employees','change-password','financial-controls','alerts']);
const whatsappFilesDir = path.join(dataDir, 'whatsapp-files');
const whatsappFilesIndexPath = path.join(whatsappFilesDir, 'index.json');
const preUpdateBackupsDir = path.join(app.getPath('documents'), 'Sarafa Backups', 'Before Update');
const appIconPath = path.join(__dirname, 'renderer', 'assets', 'sarafa-app-icon.ico');
const moduleWindows = new Map();
const execFileAsync = promisify(execFile);
const windowsBackupTaskName = 'SarafaDailyBackup';
const scheduledBackupMode = process.argv.includes('--scheduled-backup');
const updateHealthArgument = process.argv.find((arg)=>arg.startsWith('--update-health=')) || '';
let mainWindow = null;
let whatsappWebWindow = null;
let allowMainWindowClose = false;

function hideNativeMenu(win) {
  win.setMenuBarVisibility(false);
  win.setAutoHideMenuBar(false);
}

const whatsappAllowedExtensions = new Set(['jpg','jpeg','png','webp','pdf','xlsx','xls','doc','docx','txt','mp3','m4a','wav','ogg','mp4','mov','avi','mkv']);
const whatsappMaxFileBytes = 250 * 1024 * 1024;
function importExportCenterSettings() {
  ensureData();
  const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
  const configured=saved.importExportCenter || {};
  const safeDirectory=(candidate,fallback) => { try { const resolved=path.resolve(String(candidate || fallback)); return fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : fallback; } catch { return fallback; } };
  return { importFolder:safeDirectory(configured.importFolder,app.getPath('downloads')), exportFolder:safeDirectory(configured.exportFolder,app.getPath('documents')), autoSort:configured.autoSort!==false, activity:Array.isArray(configured.activity) ? configured.activity.slice(0,80) : [] };
}
function saveImportExportCenterSettings(patch={}) {
  ensureData();
  const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
  const current=importExportCenterSettings();
  saved.importExportCenter={ ...current, ...patch };
  fs.writeFileSync(settingsPath,JSON.stringify(saved,null,2),'utf8');
  return saved.importExportCenter;
}
function recordImportExportActivity(type,label,filePath='') {
  const current=importExportCenterSettings();
  const activity=[{ id:crypto.randomUUID(), type:String(type || 'info').slice(0,30), label:String(label || '').slice(0,180), filePath:String(filePath || '').slice(0,500), at:new Date().toISOString() },...current.activity].slice(0,80);
  saveImportExportCenterSettings({ activity });
}
async function chooseImportExportFolder(kind) {
  const current=importExportCenterSettings();
  const field=kind==='export'?'exportFolder':'importFolder';
  const label=kind==='export'?'مجلد التصدير':'مجلد الاستيراد';
  const selected=await dialog.showOpenDialog({ title:`اختيار ${label}`, defaultPath:current[field], properties:['openDirectory','createDirectory'] });
  if (selected.canceled || !selected.filePaths[0]) return { canceled:true };
  const folder=path.resolve(selected.filePaths[0]);
  const next=saveImportExportCenterSettings({ [field]:folder });
  recordImportExportActivity('folder',`تم تعيين ${label}`,folder);
  return { ok:true, folder:next[field], settings:importExportCenterSettings() };
}
async function openImportExportFolder(kind) {
  const current=importExportCenterSettings();
  const folder=kind==='export'?current.exportFolder:current.importFolder;
  const error=await shell.openPath(folder);
  return error ? { ok:false, error } : { ok:true, folder };
}
function importExportFileCategory(extension) {
  const ext=String(extension||'').toLowerCase();
  if (['jpg','jpeg','png','webp'].includes(ext)) return 'صور';
  if (['xlsx','xls'].includes(ext)) return 'Excel';
  if (ext==='pdf') return 'PDF';
  if (['doc','docx','txt'].includes(ext)) return 'مستندات';
  if (['mp3','m4a','wav','ogg'].includes(ext)) return 'صوت';
  if (['mp4','mov','avi','mkv'].includes(ext)) return 'فيديو';
  return 'ملفات أخرى';
}
function importExportDateParts(dateValue=new Date()) { const date=new Date(dateValue); const safe=Number.isNaN(date.getTime())?new Date():date; return { year:String(safe.getFullYear()), month:String(safe.getMonth()+1).padStart(2,'0') }; }
function uniqueImportExportPath(folder,fileName) { const ext=path.extname(fileName); const base=path.basename(fileName,ext); let candidate=path.join(folder,fileName), index=2; while(fs.existsSync(candidate)) { candidate=path.join(folder,`${base} (${index})${ext}`); index+=1; } return candidate; }
function sortedImportExportPath(kind,fileName,dateValue=new Date()) { const settings=importExportCenterSettings(); const root=kind==='export'?settings.exportFolder:settings.importFolder; const baseName=safeWhatsAppFileName(fileName); if (!settings.autoSort) { fs.mkdirSync(root,{recursive:true}); return uniqueImportExportPath(root,baseName); } const { year,month }=importExportDateParts(dateValue); const folder=path.join(root,year,month,importExportFileCategory(path.extname(baseName).slice(1))); fs.mkdirSync(folder,{recursive:true}); return uniqueImportExportPath(folder,baseName); }
function archiveImportedFile(sourcePath,dateValue=new Date()) { const destination=sortedImportExportPath('import',path.basename(sourcePath),dateValue); fs.copyFileSync(sourcePath,destination); return destination; }
async function chooseExportDestination(fileName,title,filters) { const settings=importExportCenterSettings(); if (settings.autoSort) return { canceled:false, filePath:sortedImportExportPath('export',fileName,new Date()) }; return dialog.showSaveDialog({ title, defaultPath:path.join(settings.exportFolder,fileName), filters }); }
function importedFilePath(item) { const settings=importExportCenterSettings(); const legacy=path.resolve(whatsappFilesDir,item.storedName || ''); const configured=path.resolve(String(item.storedPath || legacy)); const validRoots=[path.resolve(whatsappFilesDir),path.resolve(settings.importFolder)]; const safe=validRoots.some((root)=>configured.startsWith(`${root}${path.sep}`)); return safe ? configured : legacy; }
function isOfficialWhatsAppUrl(rawUrl) { try { const url=new URL(String(rawUrl || '')); return url.protocol==='https:' && url.hostname==='web.whatsapp.com'; } catch { return false; } }
function readWhatsAppFilesIndex() { try { const parsed=JSON.parse(fs.readFileSync(whatsappFilesIndexPath,'utf8')); return Array.isArray(parsed.items) ? parsed.items : []; } catch { return []; } }
function writeWhatsAppFilesIndex(items) { fs.writeFileSync(whatsappFilesIndexPath,JSON.stringify({ version:1, items },null,2),'utf8'); }
function safeWhatsAppFileName(name) { const ext=path.extname(String(name || '')).toLowerCase(); const base=path.basename(String(name || ''),ext).replace(/[^a-zA-Z0-9_\-\u0600-\u06FF ]/g,'_').trim().slice(0,90) || 'file'; return `${base}${ext}`; }
function findWhatsAppFile(id) { const item=readWhatsAppFilesIndex().find((entry)=>entry.id===String(id || '')); if (!item) throw new Error('الملف المطلوب غير موجود في مكتبة الوسائط'); const filePath=importedFilePath(item); if (!fs.existsSync(filePath)) throw new Error('ملف الوسائط لم يعد متاحًا محليًا'); return { item,filePath }; }

function openWhatsAppWeb(event) {
  if (whatsappWebWindow && !whatsappWebWindow.isDestroyed()) { whatsappWebWindow.focus(); return { ok:true, reused:true }; }
  const parent=event ? BrowserWindow.fromWebContents(event.sender) : mainWindow;
  const win=new BrowserWindow({ width:1180, height:820, minWidth:820, minHeight:620, parent:parent || undefined, show:false, autoHideMenuBar:false, menuBarVisible:false, title:'واتساب ويب الرسمي — صراف', icon:fs.existsSync(appIconPath) ? appIconPath : undefined, webPreferences:{ contextIsolation:true, nodeIntegration:false, sandbox:true, partition:'sarafa-whatsapp-temporary' } });
  hideNativeMenu(win); whatsappWebWindow=win;
  win.on('closed',()=>{ if (whatsappWebWindow===win) whatsappWebWindow=null; });
  win.webContents.setWindowOpenHandler(({url})=>{ if (isOfficialWhatsAppUrl(url)) win.loadURL(url); else shell.openExternal(url); return { action:'deny' }; });
  win.webContents.on('will-navigate',(navigationEvent,url)=>{ if (!isOfficialWhatsAppUrl(url)) { navigationEvent.preventDefault(); shell.openExternal(url); } });
  win.once('ready-to-show',()=>{ if (!win.isDestroyed()) win.show(); });
  win.loadURL('https://web.whatsapp.com/');
  return { ok:true, reused:false };
}

async function importWhatsAppFiles() {
  ensureData();
  const folders=importExportCenterSettings();
  const selected=await dialog.showOpenDialog({ title:'استيراد صور وملفات إلى مكتبة النظام', defaultPath:folders.importFolder, properties:['openFile','multiSelections'], filters:[{ name:'صور وملفات ووسائط مدعومة', extensions:[...whatsappAllowedExtensions] }] });
  if (selected.canceled || !selected.filePaths.length) return { canceled:true };
  const index=readWhatsAppFilesIndex(), imported=[], rejected=[];
  for (const source of selected.filePaths) {
    try {
      const stat=fs.statSync(source), extension=path.extname(source).slice(1).toLowerCase();
      if (!stat.isFile() || !whatsappAllowedExtensions.has(extension)) { rejected.push(path.basename(source)); continue; }
      if (stat.size > whatsappMaxFileBytes) { rejected.push(`${path.basename(source)} (يتجاوز 250MB)`); continue; }
      const id=crypto.randomUUID(), originalName=safeWhatsAppFileName(path.basename(source)), importedAt=new Date().toISOString(), storedPath=archiveImportedFile(source,importedAt);
      const item={ id, originalName:path.basename(storedPath), storedPath, extension, size:stat.size, importedAt }; index.unshift(item); imported.push(item);
    } catch { rejected.push(path.basename(source)); }
  }
  writeWhatsAppFilesIndex(index.slice(0,500));
  if (imported.length) recordImportExportActivity('import',`تم استيراد ${imported.length} ملف إلى المكتبة`,folders.importFolder);
  return { ok:true, imported, rejected, count:imported.length };
}

async function listWhatsAppFiles() { ensureData(); const items=readWhatsAppFilesIndex().filter((item)=>fs.existsSync(importedFilePath(item))).slice(0,100).map((item)=>{ const filePath=importedFilePath(item); return { id:item.id, name:item.originalName, extension:item.extension, size:item.size, importedAt:item.importedAt, url:pathToFileURL(filePath).toString() }; }); return { ok:true, items }; }
function dataAnalysisFileType(extension) { const ext=String(extension || '').toLowerCase(); if (['jpg','jpeg','png','webp','gif','bmp'].includes(ext)) return 'صور'; if (ext==='pdf') return 'PDF'; if (['xlsx','xls','csv'].includes(ext)) return 'Excel وبيانات'; if (['doc','docx','txt','rtf'].includes(ext)) return 'مستندات'; if (['mp3','m4a','wav','ogg'].includes(ext)) return 'صوت'; if (['mp4','mov','avi','mkv'].includes(ext)) return 'فيديو'; if (['zip','rar','7z'].includes(ext)) return 'أرشيفات'; return 'ملفات أخرى'; }
function dataAnalysisAddLargest(list,item) { list.push(item); list.sort((first,second)=>Number(second.bytes||0)-Number(first.bytes||0)); if (list.length > 12) list.length=12; }
async function scanDataAnalysisPath(id,label,root,options={}) {
  const summary={ id,label,kind:'files',path:root,bytes:0,files:0,partial:false,error:'',largest:[],fileDetails:[] };
  const types=options.types || new Map(); const maximumFiles=15000; const excluded=new Set(options.excludeNames || []);
  async function visit(folder) {
    if (summary.partial) return;
    let entries=[]; try { entries=await fs.promises.readdir(folder,{ withFileTypes:true }); } catch (error) { summary.error=summary.error || error.message || 'تعذر قراءة هذا القسم'; return; }
    for (const entry of entries) {
      if (summary.partial || excluded.has(entry.name) || entry.isSymbolicLink()) continue;
      const entryPath=path.join(folder,entry.name);
      if (entry.isDirectory()) { await visit(entryPath); continue; }
      if (!entry.isFile()) continue;
      if (summary.files >= maximumFiles) { summary.partial=true; return; }
      try { const stat=await fs.promises.stat(entryPath); const bytes=Number(stat.size || 0); const type=dataAnalysisFileType(path.extname(entry.name).slice(1)); const modifiedAt=stat.mtime.toISOString(); summary.files+=1; summary.bytes+=bytes; summary.fileDetails.push({ name:entry.name, section:label, sectionId:id, type, bytes, modifiedAt }); dataAnalysisAddLargest(summary.largest,{ name:entry.name, path:entryPath, bytes, section:label, type }); const category=types.get(type) || { label:type, bytes:0, files:0 }; category.bytes+=bytes; category.files+=1; types.set(type,category); } catch { /* يواصل التحليل الآمن عند تعذر قراءة ملف واحد */ }
    }
  }
  try { const stat=await fs.promises.stat(root); if (stat.isFile()) { const bytes=Number(stat.size || 0), name=path.basename(root), type=dataAnalysisFileType(path.extname(root).slice(1)), modifiedAt=stat.mtime.toISOString(); summary.bytes=bytes; summary.files=1; summary.fileDetails.push({ name, section:label, sectionId:id, type, bytes, modifiedAt }); dataAnalysisAddLargest(summary.largest,{ name, path:root, bytes, section:label, type }); } else if (stat.isDirectory()) await visit(root); else summary.error='المسار ليس ملفًا أو مجلدًا صالحًا'; } catch { summary.error='لا توجد ملفات محفوظة في هذا القسم بعد'; }
  return summary;
}
async function dataAnalysisDatabase() {
  const database={ available:false, name:getConfig().database || 'sarafa', bytes:0, tableCount:0, rows:0, tables:[], note:'تعذر الاتصال بقاعدة MySQL لقراءة الحجم.' };
  try { const db=await connect(); if (!db) return database; const [tables]=await db.execute("SELECT TABLE_NAME AS name, COALESCE(TABLE_ROWS,0) AS rows, COALESCE(DATA_LENGTH,0) AS dataBytes, COALESCE(INDEX_LENGTH,0) AS indexBytes, COALESCE(DATA_LENGTH,0)+COALESCE(INDEX_LENGTH,0) AS bytes FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY bytes DESC, TABLE_NAME ASC"); database.available=true; database.tables=tables.map((item)=>({ name:item.name, rows:Number(item.rows||0), dataBytes:Number(item.dataBytes||0), indexBytes:Number(item.indexBytes||0), bytes:Number(item.bytes||0) })); database.tableCount=database.tables.length; database.bytes=database.tables.reduce((total,item)=>total+item.bytes,0); database.rows=database.tables.reduce((total,item)=>total+item.rows,0); database.note='حجم الجداول والفهارس من معلومات MySQL؛ قد يكون عدد صفوف InnoDB تقديريًا.'; } catch (error) { database.note=error.message || database.note; }
  return database;
}
async function inspectAvailableMySqlDatabases() {
  const safeConfig=getConfig();
  const result={ ok:false, currentDatabase:String(safeConfig.database || ''), connection:{ host:String(safeConfig.host || ''), port:Number(safeConfig.port || 0), user:String(safeConfig.user || '') }, databases:[], note:'الفحص للقراءة فقط؛ لا ينشئ ولا يغير أي قاعدة أو جدول أو سجل.' };
  const systemSchemas=new Set(['information_schema','mysql','performance_schema','sys']);
  const trackedTables=['accounts','cashboxes','customers','currencies','vouchers','transfers','exchanges','journal_entries'];
  try {
    const db=await connect();
    if (!db) throw new Error('تعذر إنشاء اتصال MySQL');
    const [schemas]=await db.query('SHOW DATABASES');
    for (const schemaRow of schemas) {
      const name=String(schemaRow.Database || schemaRow.database || '');
      if (!name || systemSchemas.has(name)) continue;
      const [existing]=await db.execute(`SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' AND TABLE_NAME IN (${trackedTables.map(() => '?').join(',')})`,[name,...trackedTables]);
      const tables=[];
      for (const row of existing) {
        const table=String(row.name || '');
        if (!trackedTables.includes(table)) continue;
        const identifier=`\`${name.replace(/`/g,'``')}\`.\`${table}\``;
        const [countRows]=await db.query(`SELECT COUNT(*) AS records FROM ${identifier}`);
        tables.push({ name:table, records:Number(countRows?.[0]?.records || 0) });
      }
      const totalRecords=tables.reduce((sum,item) => sum+item.records,0);
      result.databases.push({ name, isCurrent:name===result.currentDatabase, tables:tables.sort((a,b) => b.records-a.records || a.name.localeCompare(b.name)), totalRecords, hasBusinessData:tables.some((item) => ['accounts','cashboxes','customers','vouchers','transfers','exchanges','journal_entries'].includes(item.name) && item.records>0) });
    }
    result.databases.sort((a,b) => Number(b.hasBusinessData)-Number(a.hasBusinessData) || b.totalRecords-a.totalRecords || a.name.localeCompare(b.name));
    result.ok=true;
    return result;
  } catch (error) {
    return { ...result, error:error.message || 'تعذر فحص قواعد MySQL المتاحة' };
  }
}
async function getDataAnalysis() {
  ensureData(); const folders=importExportCenterSettings(); const types=new Map(); const roots=new Set(); const sections=[];
  async function addSection(id,label,folder,options={}) { const resolved=path.resolve(folder); if (roots.has(resolved)) return; roots.add(resolved); sections.push(await scanDataAnalysisPath(id,label,resolved,{ ...options, types })); }
  await addSection('application','ملف التطبيق المثبت',process.execPath);
  await addSection('system-data','إعدادات وموارد النظام',dataDir,{ excludeNames:['automatic-backups','updates','whatsapp-files'] });
  await addSection('media-library','مكتبة الوسائط المحلية',whatsappFilesDir);
  await addSection('import','مجلد الاستيراد',folders.importFolder);
  await addSection('export','مجلد التصدير',folders.exportFolder);
  await addSection('automatic-backups','النسخ الاحتياطية التلقائية',automaticBackupsDir);
  await addSection('before-update','نسخ ما قبل التحديث',preUpdateBackupsDir);
  await addSection('updates','ملفات التحديث المنزلة',updatesDownloadDir);
  const database=await dataAnalysisDatabase(); const largestFiles=sections.flatMap((section)=>section.largest).sort((first,second)=>second.bytes-first.bytes).slice(0,12); const files=sections.reduce((total,section)=>total+section.files,0); const fileBytes=sections.reduce((total,section)=>total+section.bytes,0); const fileDetails=sections.flatMap((section)=>section.fileDetails).sort((first,second)=>first.section.localeCompare(second.section,'ar') || first.name.localeCompare(second.name,'ar'));
  return { ok:true, generatedAt:new Date().toISOString(), totalBytes:fileBytes+database.bytes, files, fileBytes, sections, database, types:[...types.values()].sort((first,second)=>second.bytes-first.bytes), largestFiles, fileDetails, partial:sections.some((section)=>section.partial), note:'هذا المركز للقراءة والتحليل فقط؛ لا يحذف أو ينقل أو يفتح محتوى الملفات.' };
}
async function exportWhatsAppFile(id) { const { item,filePath }=findWhatsAppFile(id); const folders=importExportCenterSettings(); let destination; if (folders.autoSort) destination=sortedImportExportPath('export',item.originalName,new Date()); else { const result=await dialog.showSaveDialog({ title:'تصدير ملف للمشاركة اليدوية', defaultPath:path.join(folders.exportFolder,item.originalName) }); if (result.canceled || !result.filePath) return { canceled:true }; destination=result.filePath; } fs.copyFileSync(filePath,destination); recordImportExportActivity('export',`تم تصدير ${item.originalName}`,destination); return { ok:true, path:destination, name:path.basename(destination) }; }
async function revealWhatsAppFile(id) { const { filePath }=findWhatsAppFile(id); shell.showItemInFolder(filePath); return { ok:true }; }

const moduleTitles = {
  calculator: 'حاسبة', 'quick-entry': 'إدخال سريع', 'exchange-buy': 'شراء العملات', 'exchange-sell': 'بيع العملات', 'voucher-payment': 'سند صرف', 'voucher-receipt': 'سند قبض',
  'transfers-outgoing': 'حوالة صادرة', 'transfers-incoming': 'حوالة واردة', accounts: 'دليل الحسابات', reports: 'التقارير',
  'currency-settings': 'دليل العملات وأسعار الصرف', settings: 'إعدادات النظام', 'print-settings': 'إعدادات الطباعة والملفات',
  'backup-center': 'النسخ والاستعادة', 'user-access': 'المستخدمون والصلاحيات', groups: 'مجموعات الصلاحيات',
  'device-access': 'أجهزة المستخدمين', employees: 'دليل الموظفين', cashboxes: 'دليل الصناديق', 'cashbox-inventory': 'جرد الصناديق', 'cashbox-count': 'جرد صندوق', 'edit-cashbox': 'تعديل صندوق', 'edit-account': 'تعديل حساب',
  'import-export': 'مركز الاستيراد والتصدير',
  'opening-balance': 'الرصيد الافتتاحي', 'simple-entries': 'القيود البسيطة', 'financial-controls': 'الرقابة والإقفال',
  'change-password': 'تغيير كلمة المرور', 'shortcut-manager': 'إدارة الاختصارات', alerts: 'مركز التنبيهات', 'audit-log': 'سجل التدقيق والمراجعة', 'layout-controls': 'لوحة التحكم', 'sheets-designer': 'مصمم Google Sheets', 'print-designer': 'مصمم الطباعة الشامل', 'ui-designer': 'مصمم الواجهة الشامل', 'window-designer': 'مصمم النوافذ الداخلية',
  'management-reports': 'التقارير الإدارية المتقدمة', cheques: 'إدارة الشيكات', 'new-cheque': 'إضافة شيك'
};
const compactModuleSizes = {
  calculator: { width:780, height:700, minWidth:600, minHeight:580 },
  'exchange-buy': { width:920, height:660, minWidth:780, minHeight:560 },
  'exchange-sell': { width:920, height:660, minWidth:780, minHeight:560 }
};

function ensureData() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(customFontsDir, { recursive: true });
  fs.mkdirSync(printTemplatesDir, { recursive: true });
  fs.mkdirSync(printReferencesDir, { recursive: true });
  fs.mkdirSync(uiButtonIconsDir, { recursive: true });
  fs.mkdirSync(uiStudioSnapshotsDir, { recursive: true });
  fs.mkdirSync(automaticBackupsDir, { recursive: true });
  fs.mkdirSync(whatsappFilesDir, { recursive: true });
  fs.mkdirSync(preUpdateBackupsDir, { recursive: true });
  if (!fs.existsSync(whatsappFilesIndexPath)) writeWhatsAppFilesIndex([]);
  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify({ branch: 'الفرع الرئيسي', baseCurrency: 'ريال يمني', fiscalYear: new Date().getFullYear(), firstRun: true, database: { host: '127.0.0.1', port: 3306, user: 'sarafa_user', password: '', database: 'sarafa' } }, null, 2));
  }
  const savedSettings=JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  if (savedSettings.database?.password && !savedSettings.database?.passwordEncrypted && safeStorage.isEncryptionAvailable()) {
    savedSettings.database=protectedDatabaseConfig(savedSettings.database);
    fs.writeFileSync(settingsPath,JSON.stringify(savedSettings,null,2),'utf8');
  }
  configure(runtimeDatabaseConfig(savedSettings.database));
}

function readBackupState() { try { return JSON.parse(fs.readFileSync(backupStatePath, 'utf8')); } catch { return {}; } }
function writeBackupState(patch) { const state={ ...readBackupState(), ...patch, updatedAt:new Date().toISOString() }; fs.writeFileSync(backupStatePath, JSON.stringify(state,null,2),'utf8'); return state; }
function sha256ForFile(filePath) { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
function preUpdateBackupId(version=app.getVersion()) { return `before-update-${String(version).replace(/[^0-9A-Za-z._-]/g,'_')}-${new Date().toISOString().replace(/[:.]/g,'-')}`; }
function preUpdateBackupPath(id) { const clean=String(id || ''); if (!/^before-update-[A-Za-z0-9._-]+$/.test(clean)) throw new Error('معرّف النسخة الاحتياطية غير صالح'); const candidate=path.resolve(preUpdateBackupsDir,clean); const root=`${path.resolve(preUpdateBackupsDir)}${path.sep}`; if (!candidate.startsWith(root)) throw new Error('مسار النسخة الاحتياطية غير صالح'); return candidate; }
function addPreUpdateBackupFile(files, source, destination, label) { if (!source || !fs.existsSync(source) || !fs.statSync(source).isFile()) return; fs.copyFileSync(source,destination); files.push({ label, file:path.basename(destination), bytes:fs.statSync(destination).size, sha256:sha256ForFile(destination) }); }
function verifyPreUpdateBackup(id) { const folder=preUpdateBackupPath(id); const manifestPath=path.join(folder,'manifest.json'); if (!fs.existsSync(manifestPath)) return { ok:false, error:'ملف تعريف النسخة الاحتياطية غير موجود' }; let manifest; try { manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')); } catch { return { ok:false, error:'ملف تعريف النسخة الاحتياطية غير صالح' }; } if (manifest?.format!=='sarafa-pre-update-backup' || !Array.isArray(manifest.files)) return { ok:false, error:'هذه ليست نسخة ما قبل تحديث معتمدة' }; for (const item of manifest.files) { const itemPath=path.join(folder,item.file || ''); if (!fs.existsSync(itemPath) || fs.statSync(itemPath).size!==item.bytes || sha256ForFile(itemPath)!==item.sha256) return { ok:false, error:`تعذر التحقق من ${item.label || item.file}` }; } try { const payload=JSON.parse(fs.readFileSync(path.join(folder,'system-backup.json'),'utf8')); if (payload?.format!=='sarafa-local-backup') return { ok:false, error:'بيانات النظام داخل النسخة غير صالحة' }; } catch { return { ok:false, error:'تعذر قراءة بيانات النظام داخل النسخة' }; } return { ok:true, id, folder, manifest };
}
function listPreUpdateBackups() { ensureData(); const entries=[]; for (const name of fs.readdirSync(preUpdateBackupsDir,{ withFileTypes:true })) { if (!name.isDirectory() || !/^before-update-[A-Za-z0-9._-]+$/.test(name.name)) continue; try { const folder=preUpdateBackupPath(name.name), manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8')); entries.push({ id:name.name, createdAt:manifest.createdAt, appVersion:manifest.appVersion, targetVersion:manifest.targetVersion || '', reason:manifest.reason || 'قبل التحديث', fileCount:Array.isArray(manifest.files)?manifest.files.length:0, bytes:Array.isArray(manifest.files)?manifest.files.reduce((sum,item)=>sum+Number(item.bytes||0),0):0 }); } catch { entries.push({ id:name.name, createdAt:'', appVersion:'—', targetVersion:'', reason:'نسخة تحتاج تحققًا', fileCount:0, bytes:0, invalid:true }); } }
  return entries.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
}
async function createPreUpdateBackup(options={}) { ensureData(); const id=preUpdateBackupId(); const folder=preUpdateBackupPath(id); fs.mkdirSync(folder,{ recursive:true }); try { const payload=await buildBackupPayload(); const files=[]; const payloadPath=path.join(folder,'system-backup.json'); fs.writeFileSync(payloadPath,JSON.stringify(payload,null,2),'utf8'); files.push({ label:'بيانات النظام والإعدادات', file:'system-backup.json', bytes:fs.statSync(payloadPath).size, sha256:sha256ForFile(payloadPath) }); addPreUpdateBackupFile(files,whatsappFilesIndexPath,path.join(folder,'files-index.json'),'فهرس مكتبة الملفات'); addPreUpdateBackupFile(files,backupStatePath,path.join(folder,'backup-state.json'),'حالة النسخ المحلية'); const executable=process.execPath; if (process.platform==='win32' && /\.exe$/i.test(executable)) addPreUpdateBackupFile(files,executable,path.join(folder,'previous-version.exe'),'الإصدار السابق للتطبيق'); const manifest={ format:'sarafa-pre-update-backup', version:1, id, createdAt:new Date().toISOString(), appVersion:app.getVersion(), targetVersion:String(options.targetVersion||''), reason:String(options.reason||'before-update'), files }; fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify(manifest,null,2),'utf8'); const verified=verifyPreUpdateBackup(id); if (!verified.ok) throw new Error(verified.error); writeBackupState({ lastPreUpdateAt:manifest.createdAt, lastPreUpdateId:id, lastPreUpdateStatus:'verified' }); return { ok:true, id, folder, manifest, verified:true }; } catch (error) { try { fs.rmSync(folder,{ recursive:true, force:true }); } catch { /* لا يبقى مجلد جزئي عند فشل النسخ */ } writeBackupState({ lastPreUpdateAt:new Date().toISOString(), lastPreUpdateStatus:'failed', lastPreUpdateError:error.message || 'تعذر إنشاء النسخة' }); throw error; }
}
async function requirePreUpdateBackup(targetVersion='') { const session=await execute('getSession'); if (!isAdministratorSession(session)) throw new Error('إنشاء نسخة ما قبل التحديث متاح لمدير النظام فقط'); return createPreUpdateBackup({ reason:'before-update', targetVersion }); }
async function preUpdateBackupsStatus() { const session=await execute('getSession'); if (!isAdministratorSession(session)) return { ok:false, error:'إدارة نسخ ما قبل التحديث متاحة لمدير النظام فقط' }; return { ok:true, folder:preUpdateBackupsDir, backups:listPreUpdateBackups(), state:readBackupState(), retention:'unlimited-manual' }; }
async function revealPreUpdateBackup(id) { const session=await execute('getSession'); if (!isAdministratorSession(session)) return { ok:false, error:'فتح النسخ الاحتياطية متاح لمدير النظام فقط' }; const verified=verifyPreUpdateBackup(id); if (!verified.ok) return verified; const error=await shell.openPath(verified.folder); return error ? { ok:false, error } : { ok:true, folder:verified.folder }; }
async function verifyStoredPreUpdateBackup(id) { const session=await execute('getSession'); if (!isAdministratorSession(session)) return { ok:false, error:'التحقق من النسخ متاح لمدير النظام فقط' }; return verifyPreUpdateBackup(id); }
async function deletePreUpdateBackup(id) { const session=await execute('getSession'); if (!isAdministratorSession(session)) return { ok:false, error:'حذف النسخ الاحتياطية متاح لمدير النظام فقط' }; const folder=preUpdateBackupPath(id); if (!fs.existsSync(folder)) return { ok:false, error:'النسخة المطلوبة غير موجودة' }; const confirmation=await dialog.showMessageBox({ type:'warning', buttons:['إلغاء','حذف النسخة'], defaultId:0, cancelId:0, title:'حذف نسخة احتياطية', message:'سيُحذف مجلد النسخة المحدد فقط ولا يمكن التراجع عن الحذف.', detail:`النسخة: ${id}` }); if (confirmation.response!==1) return { canceled:true }; fs.rmSync(folder,{ recursive:true, force:true }); return { ok:true, id }; }
function automaticBackupSettings() { ensureData(); const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8')); return { enabled:Boolean(saved.automaticBackup?.enabled), time:/^([01]\d|2[0-3]):[0-5]\d$/.test(saved.automaticBackup?.time || '') ? saved.automaticBackup.time : '23:55', google:Boolean(saved.automaticBackup?.google), local:true }; }
function backupIsFresh() { const last=Date.parse(readBackupState().lastLocalAt || ''); return Number.isFinite(last) && Date.now()-last < 26*60*60*1000; }
function safeBackupFilename() { return `sarafa-auto-backup-${new Date().toISOString().replace(/[:.]/g,'-')}.json`; }
function isAdministratorSession(session) { return Boolean(session && (session.username === 'admin' || /(مدير|مدراء|admin)/i.test(session.roleName || ''))); }
function runtimeDatabaseConfig(database={}) { const stored={ ...database }; if (stored.passwordEncrypted) { if (!safeStorage.isEncryptionAvailable()) throw new Error('تشفير Windows غير متاح لفتح كلمة مرور MySQL المخزنة'); stored.password=safeStorage.decryptString(Buffer.from(stored.passwordEncrypted,'base64')); } delete stored.passwordEncrypted; return stored; }
function protectedDatabaseConfig(database={},previous={}) { const next={ ...database }; const password=String(next.password || ''); if (!password && previous?.passwordEncrypted) { next.password=''; next.passwordEncrypted=previous.passwordEncrypted; return next; } if (!password) { delete next.passwordEncrypted; return next; } if (!safeStorage.isEncryptionAvailable()) throw new Error('تشفير Windows غير متاح لحفظ كلمة مرور MySQL بأمان على هذا الجهاز'); next.passwordEncrypted=safeStorage.encryptString(password).toString('base64'); next.password=''; return next; }
function visibleDatabaseConfig(database={}) { const visible={ ...database, password:'' }; delete visible.passwordEncrypted; return visible; }
function connectionProtectionConfig(saved) { const config=saved?.connectionProtection || {}; return { enabled:config.enabled === true, salt:typeof config.salt === 'string' ? config.salt : '', passwordHash:typeof config.passwordHash === 'string' ? config.passwordHash : '' }; }
function visibleSettingsForSession(saved,session) { const result={ ...saved, database:visibleDatabaseConfig(saved.database), connectionProtection:{ enabled:connectionProtectionConfig(saved).enabled } }; if (connectionProtectionConfig(saved).enabled && !isAdministratorSession(session)) result.database={ host:'', port:3306, user:'', password:'', database:'' }; return result; }
function connectionProtectionHash(password,salt) { return crypto.scryptSync(String(password || ''),Buffer.from(salt,'hex'),64).toString('hex'); }
function connectionProtectionMatches(config,password) { if (!config.enabled || !/^[a-f0-9]{32,}$/i.test(config.salt) || !/^[a-f0-9]{128}$/i.test(config.passwordHash)) return false; const expected=Buffer.from(config.passwordHash,'hex'); const received=Buffer.from(connectionProtectionHash(password,config.salt),'hex'); return expected.length === received.length && crypto.timingSafeEqual(expected,received); }
function connectionSettingsUnlocked(senderId) { const until=Number(connectionSettingsUnlocks.get(senderId) || 0); if (until > Date.now()) return true; connectionSettingsUnlocks.delete(senderId); return false; }
function connectionProtectionStatus() { ensureData(); const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8')); return { ok:true, enabled:connectionProtectionConfig(saved).enabled, unlockDurationMinutes:Math.round(connectionSettingsUnlockDurationMs/60_000) }; }
function adminMenuProtectionConfig(saved) { const config=saved?.adminMenuProtection || {}; return { enabled:config.enabled !== false }; }
function adminMenuUnlocked(senderId,userId) { const record=adminMenuUnlocks.get(senderId); if (record && record.userId===userId && record.until>Date.now()) return true; adminMenuUnlocks.delete(senderId); return false; }
async function adminMenuProtectionStatus(event) { ensureData(); const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8')); const session=await execute('getSession'); const config=adminMenuProtectionConfig(saved); return { ok:true, enabled:config.enabled, unlocked:!config.enabled || Boolean(session && adminMenuUnlocked(event.sender.id,session.id)), unlockDurationMinutes:Math.round(adminMenuUnlockDurationMs/60_000) }; }
async function unlockAdminMenu(event,input={}) { ensureData(); const session=await execute('getSession'); if (!isAdministratorSession(session)) return { ok:false, error:'فتح قائمة الإدارة متاح لمدير النظام فقط' }; const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8')); const config=adminMenuProtectionConfig(saved); if (!config.enabled) return { ok:true, enabled:false, unlocked:true }; try { await execute('verifyAdministratorPassword',{ password:String(input.password || '') }); } catch (error) { return { ok:false, error:error.message || 'كلمة مرور مدير النظام غير صحيحة' }; } const unlockedUntil=Date.now()+adminMenuUnlockDurationMs; adminMenuUnlocks.set(event.sender.id,{ userId:session.id, until:unlockedUntil }); return { ok:true, enabled:true, unlocked:true, unlockedUntil }; }
async function configureAdminMenuProtection(event,input={}) { ensureData(); const session=await execute('getSession'); if (!isAdministratorSession(session)) return { ok:false, error:'إدارة حماية قائمة الإدارة متاحة لمدير النظام فقط' }; const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8')); const current=adminMenuProtectionConfig(saved); const action=String(input.action || 'enable'); if (action==='disable') { try { await execute('verifyAdministratorPassword',{ password:String(input.password || '') }); } catch (error) { return { ok:false, error:error.message || 'كلمة مرور مدير النظام غير صحيحة' }; } saved.adminMenuProtection={ enabled:false, updatedAt:new Date().toISOString() }; adminMenuUnlocks.delete(event.sender.id); fs.writeFileSync(settingsPath,JSON.stringify(saved,null,2)); return { ok:true, enabled:false }; } saved.adminMenuProtection={ enabled:true, updatedAt:new Date().toISOString() }; fs.writeFileSync(settingsPath,JSON.stringify(saved,null,2)); return { ok:true, enabled:true, previouslyEnabled:current.enabled }; }
async function unlockLoginConnectionSettings(event,input={}) { ensureData(); const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8')); const protection=connectionProtectionConfig(saved); if (protection.enabled && !connectionProtectionMatches(protection,input.password)) return { ok:false, error:'كلمة حماية اتصال MySQL غير صحيحة' }; connectionSettingsUnlocks.set(event.sender.id,Date.now()+connectionSettingsUnlockDurationMs); return { ok:true, database:runtimeDatabaseConfig(saved.database || {}), unlockedUntil:Date.now()+connectionSettingsUnlockDurationMs }; }
function cleanLoginConnectionInput(input={}) { return { host:String(input.host || '127.0.0.1').trim().slice(0,200) || '127.0.0.1', port:Math.min(65535,Math.max(1,Number(input.port) || 3306)), user:String(input.user || '').trim().slice(0,160), password:String(input.password || ''), database:String(input.database || 'sarafa').trim().slice(0,160) || 'sarafa' }; }
async function saveLoginConnectionSettings(event,input={}) { ensureData(); const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8')); const protection=connectionProtectionConfig(saved); if (protection.enabled && !connectionSettingsUnlocked(event.sender.id)) return { ok:false, error:'أدخل كلمة حماية اتصال MySQL أولًا' }; const database=cleanLoginConnectionInput(input); try { saved.database=protectedDatabaseConfig(database,saved.database); fs.writeFileSync(settingsPath,JSON.stringify(saved,null,2)); configure(runtimeDatabaseConfig(saved.database)); return { ok:true }; } catch (error) { return { ok:false, error:error.message || 'تعذر حفظ اتصال MySQL المحمي' }; } }
async function configureConnectionProtection(event,input={}) { ensureData(); const session=await execute('getSession'); if (!isAdministratorSession(session)) return { ok:false, error:'إدارة حماية اتصال MySQL متاحة لمدير النظام فقط' }; const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8')); const existing=connectionProtectionConfig(saved); const action=String(input.action || 'enable'); const currentPassword=String(input.currentPassword || ''); const newPassword=String(input.newPassword || ''); if (existing.enabled && !connectionProtectionMatches(existing,currentPassword)) return { ok:false, error:'كلمة الحماية الحالية غير صحيحة' }; if (action === 'disable') { delete saved.connectionProtection; connectionSettingsUnlocks.delete(event.sender.id); fs.writeFileSync(settingsPath,JSON.stringify(saved,null,2)); return { ok:true, enabled:false }; } if (newPassword.length < 8) return { ok:false, error:'كلمة الحماية يجب أن تتكون من 8 أحرف على الأقل' }; const salt=crypto.randomBytes(16).toString('hex'); saved.connectionProtection={ enabled:true, salt, passwordHash:connectionProtectionHash(newPassword,salt), updatedAt:new Date().toISOString() }; fs.writeFileSync(settingsPath,JSON.stringify(saved,null,2)); connectionSettingsUnlocks.set(event.sender.id,Date.now()+connectionSettingsUnlockDurationMs); return { ok:true, enabled:true }; }

const DEFAULT_UPDATE_MANIFEST_URL = 'https://github.com/marwan700074766/almotamyez-app-updates/releases/download/v3.24.11/update-manifest.json';
function updateSettings() {
  ensureData();
  const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return { manifestUrl: String(saved.updates?.manifestUrl || DEFAULT_UPDATE_MANIFEST_URL).trim(), defaultSource: DEFAULT_UPDATE_MANIFEST_URL };
}

async function requireUpdateAdministrator() {
  const session = await execute('getSession');
  if (!isAdministratorSession(session)) throw new Error('فحص وتنزيل تحديثات النظام متاح لمدير النظام فقط');
}

async function appUpdateStatus() {
  const currentVersion = app.getVersion();
  const config = updateSettings();
  return { ok:true, currentVersion, configured:Boolean(config.manifestUrl), manifestUrl:config.manifestUrl };
}

async function checkForAppUpdate() {
  await requireUpdateAdministrator();
  const status = await appUpdateStatus();
  if (!status.configured) return { ...status, available:false, reason:'not-configured' };
  const manifest = await fetchManifest(status.manifestUrl);
  const comparison = compareVersions(manifest.version, status.currentVersion);
  return { ...status, available:comparison > 0, manifest, reason:comparison > 0 ? 'available' : comparison === 0 ? 'current' : 'installed-newer' };
}

async function downloadAppUpdate() {
  await requireUpdateAdministrator();
  const result = await checkForAppUpdate();
  if (!result.available) return { ok:false, error:'لا يوجد إصدار أحدث جاهز للتنزيل' };
  const downloaded = await downloadAndVerify(result.manifest, updatesDownloadDir);
  return { ok:true, currentVersion:result.currentVersion, version:result.manifest.version, releaseNotes:result.manifest.releaseNotes, downloaded };
}
function updateHealthMarkerPath(id) { return path.join(preUpdateBackupPath(id),'update-health.json'); }
function markUpdateHealthOnLaunch() { if (!updateHealthArgument) return; const id=updateHealthArgument.slice('--update-health='.length); try { const verified=verifyPreUpdateBackup(id); if (!verified.ok) return; fs.writeFileSync(updateHealthMarkerPath(id),JSON.stringify({ ok:true, launchedAt:new Date().toISOString(), version:app.getVersion() },null,2),'utf8'); writeBackupState({ lastUpdateHealthAt:new Date().toISOString(), lastUpdateHealthId:id, lastUpdateHealthStatus:'healthy' }); } catch { /* لا يؤثر فشل تسجيل الصحة على فتح التطبيق */ } }
function safeUpdateExecutable(filePath) { const resolved=path.resolve(String(filePath || '')); const safeRoot=`${path.resolve(updatesDownloadDir)}${path.sep}`; if (!resolved.startsWith(safeRoot) || !/\.exe$/i.test(resolved) || !fs.existsSync(resolved)) throw new Error('ملف التحديث المطلوب غير متاح'); return resolved; }
function batchValue(value) { return String(value || '').replace(/[\r\n"]/g,''); }
function logUpdateInstall(message, error) { try { fs.mkdirSync(updatesDownloadDir, { recursive:true }); const detail=error ? ` ${error.stack || error.message || error}` : ''; fs.appendFileSync(updateInstallLogPath, `[${new Date().toISOString()}] ${message}${detail}\r\n`, 'utf8'); } catch { /* logging must not block installation */ } }
async function installDownloadedAppUpdate(input={}) {
  try {
    await requireUpdateAdministrator();
    const updateFile=safeUpdateExecutable(input.filePath);
    const targetVersion=String(input.version || '').trim();
    const backup=await requirePreUpdateBackup(targetVersion);
    const verified=verifyPreUpdateBackup(backup.id);
    if (!verified.ok) return { ok:false, error:`توقف التحديث: ${verified.error}` };
    const previous=path.join(verified.folder,'previous-version.exe');
    if (process.platform!=='win32' || !/\.exe$/i.test(process.execPath) || !fs.existsSync(previous)) return { ok:false, error:'التثبيت المباشر متاح من ملف Windows التنفيذي المثبّت فقط' };
    const marker=updateHealthMarkerPath(backup.id);
    const scriptPath=path.join(updatesDownloadDir,`apply-update-${Date.now()}.cmd`);
    const target=process.execPath;
    const script=['@echo off','setlocal',`set "TARGET=${batchValue(target)}"`,`set "UPDATE=${batchValue(updateFile)}"`,`set "PREVIOUS=${batchValue(previous)}"`,`set "MARKER=${batchValue(marker)}"`,`set "BACKUP_ID=${batchValue(backup.id)}"`,'timeout /t 2 /nobreak >nul','copy /Y "%UPDATE%" "%TARGET%" >nul','if errorlevel 1 goto restore','del /Q "%MARKER%" >nul 2>&1','start "" "%TARGET%" "--update-health=%BACKUP_ID%"','timeout /t 25 /nobreak >nul','if exist "%MARKER%" goto cleanup',':restore','copy /Y "%PREVIOUS%" "%TARGET%" >nul','start "" "%TARGET%"',':cleanup','del "%~f0"'].join('\r\n');
    fs.writeFileSync(scriptPath,script,'utf8');
    const child=spawn('cmd.exe',['/d','/c',scriptPath],{ detached:true, windowsHide:true, stdio:'ignore' });
    child.once('error',(error)=>logUpdateInstall('فشل تشغيل سكربت تثبيت التحديث',error));
    child.unref();
    logUpdateInstall(`تم تجهيز تثبيت الإصدار ${targetVersion} من ${updateFile}`);
    writeBackupState({ lastPreUpdateId:backup.id, lastPreUpdateStatus:'applying-update', pendingUpdateVersion:targetVersion });
    allowMainWindowClose=true;
    setImmediate(()=>app.quit());
    return { ok:true, restarting:true, backup:{ id:backup.id, folder:backup.folder } };
  } catch (error) {
    logUpdateInstall('فشل تثبيت التحديث',error);
    return { ok:false, error:error.message || 'تعذر تشغيل مثبت التحديث' };
  }
}

async function revealDownloadedUpdate(filePath) {
  await requireUpdateAdministrator();
  const resolved = path.resolve(String(filePath || ''));
  const safeRoot = `${path.resolve(updatesDownloadDir)}${path.sep}`;
  if (!resolved.startsWith(safeRoot) || !/\.exe$/i.test(resolved) || !fs.existsSync(resolved)) throw new Error('ملف التحديث المطلوب غير متاح');
  shell.showItemInFolder(resolved);
  return { ok:true, path:resolved };
}

async function configureUpdateSource(input = {}) {
  await requireUpdateAdministrator();
  const manifestUrl = String(input.manifestUrl || '').trim();
  if (manifestUrl && !isHttpsUrl(manifestUrl)) return { ok:false, error:'رابط ملف تعريف التحديث يجب أن يبدأ بـ HTTPS' };
  const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  saved.updates = { ...(saved.updates || {}), manifestUrl, configuredAt:new Date().toISOString() };
  fs.writeFileSync(settingsPath, JSON.stringify(saved, null, 2));
  return { ok:true, configured:Boolean(manifestUrl), manifestUrl };
}

async function updateBackupHealth(result) {
  const db=await connect(); if (!db) return;
  await db.execute("INSERT INTO app_settings (setting_key, setting_value) VALUES ('backup_last_at', ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",[result.lastLocalAt]);
  await db.execute("INSERT INTO app_settings (setting_key, setting_value) VALUES ('backup_last_status', ?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",[result.google?.ok === false ? 'local_only' : 'complete']);
}
async function uploadBackupPayloadToGoogle(payload, filename) {
  const auth=await getDriveAuth(); const drive=google.drive({ version:'v3', auth }); const folderId=await getSarafaDriveFolder(drive);
  const file=await drive.files.create({ requestBody:{ name:filename, parents:[folderId], mimeType:'application/json' }, media:{ mimeType:'application/json', body:JSON.stringify(payload) }, fields:'id,name,createdTime' });
  return { ok:true, name:file.data.name, id:file.data.id };
}
async function runAutomaticBackup(options = {}) {
  ensureData(); const payload=await buildBackupPayload(); const filename=safeBackupFilename(); const localPath=path.join(automaticBackupsDir,filename);
  fs.writeFileSync(localPath,JSON.stringify(payload,null,2),'utf8');
  const result={ ok:true, reason:options.reason || 'manual', lastLocalAt:new Date().toISOString(), local:{ ok:true, path:localPath, name:filename }, google:{ ok:false, skipped:true } };
  if (options.uploadGoogle !== false) { try { result.google=await uploadBackupPayloadToGoogle(payload,filename); } catch (error) { result.google={ ok:false, error:error.message || 'تعذر رفع نسخة Google Drive' }; } }
  writeBackupState(result); try { await updateBackupHealth(result); } catch { /* تبقى حالة النسخة المحلية محفوظة */ } return result;
}
function taskCommand() { return `"${process.execPath}" --scheduled-backup`; }
async function installWindowsDailyBackupTask(time) {
  if (process.platform !== 'win32') return { ok:true, simulated:true, command:`schtasks /Create /TN ${windowsBackupTaskName} /SC DAILY /ST ${time}` };
  await execFileAsync('schtasks.exe',['/Create','/TN',windowsBackupTaskName,'/SC','DAILY','/ST',time,'/TR',taskCommand(),'/RL','LIMITED','/F'],{ windowsHide:true }); return { ok:true };
}
async function configureAutomaticBackup(input = {}) {
  const session=await execute('getSession'); if (!isAdministratorSession(session)) return { ok:false, error:'إعداد النسخ التلقائي متاح لمدير النظام فقط' };
  if (!fs.existsSync(driveClientPath) || !fs.existsSync(driveTokenPath)) return { ok:false, error:'اربط Google Drive أولًا ثم فعّل النسخ اليومي التلقائي' };
  const time=/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.time || '')) ? String(input.time) : '23:55'; const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
  saved.automaticBackup={ enabled:true, time, google:true, local:true, taskName:windowsBackupTaskName, configuredAt:new Date().toISOString() }; fs.writeFileSync(settingsPath,JSON.stringify(saved,null,2),'utf8');
  try { return { ok:true, time, task:await installWindowsDailyBackupTask(time) }; } catch (error) { return { ok:false, error:`تعذر إنشاء مهمة Windows اليومية: ${error.message || 'تحقق من صلاحيات المستخدم'}` }; }
}

function promptBackupBeforeClose(event, win) {
  const config=automaticBackupSettings();
  if (!config.enabled || backupIsFresh()) return false;
  event.preventDefault();
  const answer=dialog.showMessageBoxSync(win,{ type:'warning', title:'نسخة احتياطية مطلوبة', message:'لا توجد نسخة احتياطية حديثة خلال آخر 26 ساعة.', detail:'يمكن إنشاء نسخة محلية ونسخة Google Drive الآن قبل إغلاق النظام.', buttons:['نسخ الآن ثم إغلاق','إغلاق دون نسخة','إلغاء الإغلاق'], defaultId:0, cancelId:2 });
  if (answer === 2) return true;
  if (answer === 1) { allowMainWindowClose=true; win.close(); return true; }
  runAutomaticBackup({ reason:'app-close', uploadGoogle:true }).finally(() => { allowMainWindowClose=true; if (!win.isDestroyed()) win.close(); });
  return true;
}

function recoveryEmailSettings() {
  try {
    const stored=JSON.parse(fs.readFileSync(recoveryMailPath,'utf8'));
    const password=safeStorage.isEncryptionAvailable() && stored.password ? safeStorage.decryptString(Buffer.from(stored.password,'base64')) : '';
    return { ...stored, password };
  } catch { return null; }
}
async function configureRecoveryEmail(input = {}) {
  const session=await execute('getSession'); if (!isAdministratorSession(session)) return { ok:false, error:'إعداد بريد الاستعادة متاح لمدير النظام فقط' };
  const host=String(input.host || '').trim(); const from=String(input.from || '').trim(); const username=String(input.username || '').trim(); const password=String(input.password || ''); const port=Number(input.port || 587);
  if (!host || !from.includes('@') || !username || !password || !Number.isInteger(port) || port < 1 || port > 65535) return { ok:false, error:'أدخل خادم البريد والمنفذ والبريد واسم المستخدم وكلمة مرور التطبيق بصورة صحيحة' };
  if (!safeStorage.isEncryptionAvailable()) return { ok:false, error:'تشفير Windows غير متاح لحفظ كلمة مرور البريد بأمان على هذا الجهاز' };
  const saved={ host, port, secure:Boolean(input.secure), from, username, password:safeStorage.encryptString(password).toString('base64'), configuredAt:new Date().toISOString() };
  fs.writeFileSync(recoveryMailPath,JSON.stringify(saved,null,2),'utf8'); return { ok:true, from };
}
async function requestManagerPasswordRecoveryByEmail() {
  const config=recoveryEmailSettings(); if (!config?.host || !config.password) return { ok:false, error:'لم يُعدّ مدير النظام بريد الاستعادة بعد' };
  let transporter;
  try { transporter=nodemailer.createTransport({ host:config.host, port:config.port, secure:Boolean(config.secure), auth:{ user:config.username, pass:config.password } }); await transporter.verify(); }
  catch { return { ok:false, error:'تعذر الاتصال بخادم بريد الاستعادة. تحقق من الإعدادات أو كلمة مرور التطبيق' }; }
  const recovery=await execute('requestManagerPasswordRecovery');
  try { await transporter.sendMail({ from:config.from, to:config.from, subject:'رمز استعادة مدير نظام الصراف', text:`رمز استعادة كلمة مرور مدير النظام هو: ${recovery.code}\nصالح لمدة 15 دقيقة. لا تشاركه مع أي شخص.`, html:`<div dir="rtl"><h2>استعادة كلمة مرور مدير نظام الصراف</h2><p>رمز الاستعادة:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px">${recovery.code}</p><p>الرمز صالح لمدة 15 دقيقة. لا تشاركه مع أي شخص.</p></div>` }); return { ok:true, expiresAt:recovery.expiresAt }; }
  catch { return { ok:false, error:'تعذر إرسال رمز الاستعادة. لم تُرسل أي كلمة مرور عبر البريد.' }; }
}

function createWindow() {
  ensureData();
  const ui = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).uiDesigner || {};
  const width = Math.max(1050, Math.min(2200, Number(ui.mainWidth || 1280)));
  const height = Math.max(680, Math.min(1400, Number(ui.mainHeight || 820)));
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 1050,
    minHeight: 680,
    show: false,
    autoHideMenuBar: false,
    menuBarVisible: false,
    backgroundColor: '#f4f7fb',
    title: 'نظام الصراف الشامل',
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  hideNativeMenu(win);
  mainWindow = win;
  win.on('close', (event) => { if (!allowMainWindowClose && !scheduledBackupMode && promptBackupBeforeClose(event, win)) return; });
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.maximize(); win.show(); } });
  win.webContents.once('did-fail-load', () => { if (!win.isDestroyed() && !win.isVisible()) win.show(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

function openModuleWindow(event, moduleName) {
  const view = String(moduleName || 'dashboard');
  const existing = moduleWindows.get(view);
  if (existing && !existing.isDestroyed()) { existing.maximize(); if (existing.isVisible()) existing.focus(); return { ok: true, reused: true, loading: !existing.isVisible() }; }
  const parent = BrowserWindow.fromWebContents(event.sender);
  const savedSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const ui = savedSettings.uiDesigner || {};
  const compact = compactModuleSizes[view];
  const designed = savedSettings.windowDesigner?.targets?.[view] || savedSettings.sheetsDesigner?.surfaces?.[view] || {};
  const fallback = compact ? { width:compact.width, height:compact.height, minWidth:compact.minWidth, minHeight:compact.minHeight } : { width:Number(ui.moduleWidth || 1060), height:Number(ui.moduleHeight || 740), minWidth:820, minHeight:580 };
  const minWidth = Math.max(720, Math.min(1400, Number(designed.minWidth || fallback.minWidth)));
  const minHeight = Math.max(520, Math.min(1000, Number(designed.minHeight || fallback.minHeight)));
  const width = Math.max(minWidth, Math.min(1800, Number(designed.width || fallback.width)));
  const height = Math.max(minHeight, Math.min(1300, Number(designed.height || fallback.height)));
  const win = new BrowserWindow({
    width,
    height,
    minWidth,
    minHeight,
    parent,
    show: false,
    autoHideMenuBar: false,
    menuBarVisible: false,
    title: `${String(designed.title || moduleTitles[view] || 'نافذة عمل').slice(0,100)} — صراف`,
    backgroundColor: /^#[0-9a-f]{6}$/i.test(String(designed.windowBg || '')) ? designed.windowBg : '#eef3f8',
    icon: fs.existsSync(appIconPath) ? appIconPath : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  hideNativeMenu(win);
  moduleWindows.set(view, win);
  win.on('closed', () => moduleWindows.delete(view));
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.maximize(); win.show(); win.focus(); } });
  win.webContents.once('did-fail-load', () => { if (!win.isDestroyed() && !win.isVisible()) win.show(); });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { module: view } });
  return { ok: true, reused: false, loading: true };
}

ipcMain.handle('get-settings', async () => { ensureData(); const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8')); return visibleSettingsForSession(saved,await execute('getSession')); });
ipcMain.handle('admin-menu-protection-status', (event) => adminMenuProtectionStatus(event));
ipcMain.handle('unlock-admin-menu', (event,input={}) => unlockAdminMenu(event,input));
ipcMain.handle('configure-admin-menu-protection', (event,input={}) => configureAdminMenuProtection(event,input));
ipcMain.handle('connection-protection-status', () => connectionProtectionStatus());
ipcMain.handle('unlock-login-connection-settings', (event,input={}) => unlockLoginConnectionSettings(event,input));
ipcMain.handle('save-login-connection-settings', (event,input={}) => saveLoginConnectionSettings(event,input));
ipcMain.handle('configure-connection-protection', (event,input={}) => configureConnectionProtection(event,input));
ipcMain.handle('get-app-info', () => ({ version: app.getVersion(), productName: 'نظام الصراف الشامل' }));
ipcMain.handle('get-import-export-center', () => ({ ok:true, ...importExportCenterSettings() }));
ipcMain.handle('get-data-analysis', async () => { try { return await getDataAnalysis(); } catch (error) { return { ok:false, error:error.message || 'تعذر تحليل بيانات النظام' }; } });
ipcMain.handle('inspect-available-mysql-databases', async () => inspectAvailableMySqlDatabases());
ipcMain.handle('choose-import-export-folder', async (_event, kind) => chooseImportExportFolder(kind));
ipcMain.handle('open-import-export-folder', async (_event, kind) => openImportExportFolder(kind));
ipcMain.handle('set-import-export-auto-sort', (_event, active) => { const autoSort=Boolean(active); const next=saveImportExportCenterSettings({ autoSort }); recordImportExportActivity('folder',`تم ${autoSort?'تفعيل':'إيقاف'} الفرز التلقائي للملفات`,autoSort?'':''); return { ok:true, ...next }; });
ipcMain.handle('app-update-status', async () => { try { return await appUpdateStatus(); } catch (error) { return { ok:false, error:error.message || 'تعذر قراءة حالة التحديث' }; } });
ipcMain.handle('check-app-update', async () => { try { return await checkForAppUpdate(); } catch (error) { return { ok:false, error:error.message || 'تعذر فحص التحديث' }; } });
ipcMain.handle('download-app-update', async () => { try { return await downloadAppUpdate(); } catch (error) { return { ok:false, error:error.message || 'تعذر تنزيل التحديث' }; } });
ipcMain.handle('install-downloaded-app-update', async (_event,input={}) => { try { return await installDownloadedAppUpdate(input); } catch (error) { return { ok:false, error:error.message || 'تعذر تثبيت التحديث' }; } });
ipcMain.handle('reveal-downloaded-update', async (_event, filePath) => { try { return await revealDownloadedUpdate(filePath); } catch (error) { return { ok:false, error:error.message || 'تعذر فتح موقع التحديث' }; } });
ipcMain.handle('configure-update-source', async (_event, input = {}) => { try { return await configureUpdateSource(input); } catch (error) { return { ok:false, error:error.message || 'تعذر حفظ مصدر التحديث' }; } });
ipcMain.handle('create-pre-update-backup', async () => { try { return await requirePreUpdateBackup(''); } catch (error) { return { ok:false, error:error.message || 'تعذر إنشاء نسخة ما قبل التحديث' }; } });
ipcMain.handle('pre-update-backups-status', async () => { try { return await preUpdateBackupsStatus(); } catch (error) { return { ok:false, error:error.message || 'تعذر قراءة نسخ ما قبل التحديث' }; } });
ipcMain.handle('reveal-pre-update-backup', async (_event,id) => { try { return await revealPreUpdateBackup(id); } catch (error) { return { ok:false, error:error.message || 'تعذر فتح النسخة الاحتياطية' }; } });
ipcMain.handle('verify-pre-update-backup', async (_event,id) => { try { return await verifyStoredPreUpdateBackup(id); } catch (error) { return { ok:false, error:error.message || 'تعذر التحقق من النسخة الاحتياطية' }; } });
ipcMain.handle('delete-pre-update-backup', async (_event,id) => { try { return await deletePreUpdateBackup(id); } catch (error) { return { ok:false, error:error.message || 'تعذر حذف النسخة الاحتياطية' }; } });
ipcMain.handle('automatic-backup-status', async () => ({ ok:true, settings:automaticBackupSettings(), state:readBackupState(), fresh:backupIsFresh(), googleConnected:fs.existsSync(driveClientPath) && fs.existsSync(driveTokenPath) }));
ipcMain.handle('configure-automatic-backup', async (_event, input = {}) => configureAutomaticBackup(input));
ipcMain.handle('configure-recovery-email', async (_event, input = {}) => configureRecoveryEmail(input));
ipcMain.handle('request-manager-password-recovery', async () => { try { return await requestManagerPasswordRecoveryByEmail(); } catch (error) { return { ok:false, error:error.message || 'تعذر طلب رمز الاستعادة' }; } });
ipcMain.handle('complete-manager-password-recovery', async (_event, input = {}) => { try { return { ok:true, data:await execute('completeManagerPasswordRecovery',input) }; } catch (error) { return { ok:false, error:error.message || 'تعذر تعيين كلمة المرور الجديدة' }; } });
ipcMain.handle('run-automatic-backup', async () => {
  const session=await execute('getSession'); if (!isAdministratorSession(session)) return { ok:false, error:'إنشاء النسخة التلقائية متاح لمدير النظام فقط' };
  try { return await runAutomaticBackup({ reason:'manual-test', uploadGoogle:true }); } catch (error) { return { ok:false, error:error.message || 'تعذر إنشاء النسخة التلقائية' }; }
});
ipcMain.handle('save-settings', async (_event, settings) => {
  const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const session=await execute('getSession');
  const protection=connectionProtectionConfig(saved);
  const next = { ...settings, uiStudioSnapshots:settings.uiStudioSnapshots || saved.uiStudioSnapshots, connectionProtection:saved.connectionProtection };
  if (protection.enabled && !isAdministratorSession(session)) next.database=saved.database;
  else next.database=protectedDatabaseConfig(settings.database || {},saved.database);
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2));
  configure(runtimeDatabaseConfig(next.database));
  return { ok: true };
});
ipcMain.handle('capture-ui-studio-preview', async (event, input = {}) => {
  try {
    ensureData();
    const rawTarget=String(input.target || 'dashboard').replace(/[^a-z-]/g,'').slice(0,80) || 'dashboard';
    const rawRect=input.rect || {};
    const rect={ x:Math.max(0,Math.round(Number(rawRect.x) || 0)), y:Math.max(0,Math.round(Number(rawRect.y) || 0)), width:Math.max(1,Math.min(4000,Math.round(Number(rawRect.width) || 1))), height:Math.max(1,Math.min(8000,Math.round(Number(rawRect.height) || 1)))};
    const image=await event.sender.capturePage(rect);
    const capturedAt=new Date().toISOString();
    const fileName=`${rawTarget}-${capturedAt.replace(/[:.]/g,'-')}.png`;
    const filePath=path.join(uiStudioSnapshotsDir,fileName);
    fs.writeFileSync(filePath,image.toPNG());
    const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
    const previous=Array.isArray(saved.uiStudioSnapshots?.items) ? saved.uiStudioSnapshots.items : [];
    const item={ target:rawTarget, fileName, url:pathToFileURL(filePath).toString(), capturedAt, width:rect.width, height:rect.height };
    saved.uiStudioSnapshots={ schemaVersion:1, items:[item,...previous.filter((entry)=>entry?.target!==rawTarget)].slice(0,18), updatedAt:capturedAt };
    fs.writeFileSync(settingsPath,JSON.stringify(saved,null,2),'utf8');
    return { ok:true, snapshot:item };
  } catch (error) { return { ok:false, error:error.message || 'تعذر التقاط صورة المعاينة المباشرة' }; }
});
ipcMain.handle('select-print-logo', async () => {
  const selected = await dialog.showOpenDialog({
    title: 'اختيار شعار المنشأة للطباعة',
    properties: ['openFile'],
    filters: [{ name: 'ملفات الصور', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
  });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  try {
    ensureData();
    const source = selected.filePaths[0];
    const extension = path.extname(source).toLowerCase() || '.png';
    for (const item of fs.readdirSync(dataDir)) {
      if (item.startsWith('print-logo.')) fs.unlinkSync(path.join(dataDir, item));
    }
    const destination = `${printLogoPath}${extension}`;
    fs.copyFileSync(source, destination);
    return { ok: true, path: destination, url: pathToFileURL(destination).href };
  } catch (error) {
    return { ok: false, error: error.message || 'تعذر حفظ الشعار المختار' };
  }
});
ipcMain.handle('clear-print-logo', () => {
  try {
    if (fs.existsSync(dataDir)) {
      for (const item of fs.readdirSync(dataDir)) {
        if (item.startsWith('print-logo.')) fs.unlinkSync(path.join(dataDir, item));
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || 'تعذر حذف الشعار' };
  }
});
ipcMain.handle('select-custom-font', async () => {
  const selected = await dialog.showOpenDialog({ title: 'اختيار ملف خط لإضافته إلى مكتبة النظام', properties: ['openFile'], filters: [{ name: 'ملفات الخطوط', extensions: ['ttf', 'otf', 'woff', 'woff2'] }] });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  try {
    ensureData(); const source = selected.filePaths[0]; const extension = path.extname(source).toLowerCase();
    const safeBase = path.basename(source, extension).replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g, '_').slice(0, 80) || `font-${Date.now()}`;
    const destination = path.join(customFontsDir, `${Date.now()}-${safeBase}${extension}`);
    fs.copyFileSync(source, destination);
    return { ok:true, name:safeBase.replace(/[_-]+/g, ' '), path:destination, url:pathToFileURL(destination).href, extension };
  } catch (error) { return { ok:false, error:error.message || 'تعذر إضافة الخط المحدد' }; }
});
ipcMain.handle('delete-custom-font', (_event, fontPath) => {
  try {
    const resolved = path.resolve(String(fontPath || ''));
    if (!resolved.startsWith(path.resolve(customFontsDir) + path.sep)) return { ok:false, error:'ملف الخط غير مسموح' };
    if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    return { ok:true };
  } catch (error) { return { ok:false, error:error.message || 'تعذر حذف الخط' }; }
});
ipcMain.handle('open-font-library', async () => {
  const session = await execute('getSession');
  if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' };
  await shell.openExternal('https://fonts.google.com/');
  return { ok:true };
});
const printTemplateDesignKeys = new Set(['paperSize','orientation','pageMargin','contentPadding','fontFamily','fontSize','headerFontSize','titleFontSize','headerColor','titleColor','borderColor','textColor','pageColor','documentStyle','logoSize','logoPosition','headerAlign','titleAlign','titleVertical','detailsLayout','footerAlign','signatureLayout','showLogo','showCompany','showBranch','showPrintMeta','showVoucherNo','showVoucherDate','showAmount','showAmountText','showReference','showSignatures','showFooter','showWatermark','companyText','branchText','headerText','documentTitle','partyLabel','purposeLabel','footerText','watermarkText','signatureOne','signatureTwo','signatureThree','elementOffsets','hiddenSections','sectionOrder']);
const printTemplateEnums = { paperSize:['A4','A5','Letter'], orientation:['portrait','landscape'], documentStyle:['classic','executive','compact','minimal'], logoPosition:['right','center','left'], headerAlign:['right','center','left'], titleAlign:['right','center','left'], titleVertical:['top','bottom'], detailsLayout:['side','stacked'], footerAlign:['right','center','left'], signatureLayout:['spread','center','stack'] };
const printTemplateColors = new Set(['headerColor','titleColor','borderColor','textColor','pageColor']);
const printTemplateNumbers = new Set(['pageMargin','contentPadding','fontSize','headerFontSize','titleFontSize','logoSize']);
function safePrintTemplateDesign(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('قالب الطباعة لا يحتوي على إعدادات صالحة');
  const design = {};
  for (const [key, value] of Object.entries(input)) {
    if (!printTemplateDesignKeys.has(key)) continue;
    if (printTemplateEnums[key]) { if (printTemplateEnums[key].includes(value)) design[key] = value; }
    else if (printTemplateColors.has(key)) { if (/^#[0-9a-f]{6}$/i.test(String(value || ''))) design[key] = String(value).toLowerCase(); }
    else if (key === 'fontFamily' && typeof value === 'string') { const family=value.replace(/[^a-zA-Z0-9\s,\-_'\u0600-\u06FF]/g,'').trim().slice(0,180); if (family) design[key]=family; }
    else if (printTemplateNumbers.has(key) && typeof value === 'number' && Number.isFinite(value)) design[key] = Math.max(0, Math.min(500, value));
    else if (typeof value === 'string') design[key] = value.slice(0, 500);
    else if (typeof value === 'boolean') design[key] = value;
    else if (key === 'hiddenSections' && Array.isArray(value)) design[key] = value.filter((item) => ['header','title','content','signatures','footer'].includes(item));
    else if (key === 'sectionOrder' && Array.isArray(value)) design[key] = value.filter((item) => ['header','title','content','signatures','footer'].includes(item));
    else if (key === 'elementOffsets' && value && typeof value === 'object' && !Array.isArray(value)) design[key] = Object.fromEntries(Object.entries(value).filter(([item]) => ['header','title','amount','details','signatures','footer'].includes(item)).map(([item, offset]) => [item,{ x:Math.max(-160,Math.min(160,Number(offset?.x) || 0)), y:Math.max(-160,Math.min(160,Number(offset?.y) || 0)) }]));
  }
  if (!Object.keys(design).length) throw new Error('لم يتم العثور على خصائص تصميم معتمدة في القالب');
  return design;
}
function detectPrintReferenceMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { mime:'image/png', extension:'.png' };
  if (buffer.length >= 3 && buffer.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) return { mime:'image/jpeg', extension:'.jpg' };
  if (buffer.length >= 12 && buffer.subarray(0,4).toString('ascii') === 'RIFF' && buffer.subarray(8,12).toString('ascii') === 'WEBP') return { mime:'image/webp', extension:'.webp' };
  return null;
}
function safePrintReferenceName(value, fallback = 'سند') { return path.basename(String(value || fallback),path.extname(String(value || fallback))).replace(/[^a-zA-Z0-9_\-\u0600-\u06FF]/g,'_').slice(0,70) || fallback; }
function saveRenderedPrintReference(dataUrl, name = 'سند PDF') {
  const match=String(dataUrl || '').match(/^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/);
  if (!match) throw new Error('صورة PDF المحولة غير صالحة');
  const buffer=Buffer.from(match[1],'base64');
  if (!buffer.length || buffer.length > 8 * 1024 * 1024 || !detectPrintReferenceMime(buffer)) throw new Error('صورة PDF المحولة غير صالحة أو كبيرة جدًا');
  ensureData(); const destination=path.join(printReferencesDir,`${Date.now()}-${safePrintReferenceName(name)}.png`); fs.writeFileSync(destination,buffer);
  return { name:`${safePrintReferenceName(name)}.png`, size:buffer.length, mime:'image/png', path:destination, url:pathToFileURL(destination).href, source:'pdf' };
}
const printPdfTemplatesIndexPath = path.join(printReferencesDir, 'pdf-templates.json');
function readPrintPdfTemplates() { try { const raw=JSON.parse(fs.readFileSync(printPdfTemplatesIndexPath,'utf8')); return Array.isArray(raw.items) ? raw.items : []; } catch { return []; } }
function writePrintPdfTemplates(items) { ensureData(); fs.writeFileSync(printPdfTemplatesIndexPath,JSON.stringify({ version:1, items },null,2),'utf8'); }
function assertPdfFile(filePath) { const stat=fs.statSync(filePath); if (!stat.isFile()) throw new Error('الملف المحدد ليس ملفًا'); if (stat.size > 25 * 1024 * 1024) throw new Error('ملف PDF كبير جدًا؛ الحد الأقصى 25MB'); const header=fs.readFileSync(filePath).subarray(0,5); if (header.toString('ascii') !== '%PDF-') throw new Error('ملف PDF غير صالح'); return stat; }
function addPrintPdfTemplateFromPath(sourcePath, metadata={}) { ensureData(); const stat=assertPdfFile(sourcePath); const sourceName=path.basename(sourcePath); const id=crypto.randomUUID(); const destination=path.join(printReferencesDir,`${Date.now()}-${id}.pdf`); fs.copyFileSync(sourcePath,destination); const item={ id, name:String(metadata.name || path.basename(sourceName,path.extname(sourceName))).slice(0,100), source:metadata.source || 'local', sourceName, storedPath:destination, size:stat.size, importedAt:new Date().toISOString(), previewPath:'', previewUrl:'' }; writePrintPdfTemplates([item,...readPrintPdfTemplates()].slice(0,80)); recordImportExportActivity('print-template',`تم استيراد نموذج PDF: ${item.name}`,destination); return { ...item, path:destination, url:pathToFileURL(destination).href }; }
function listPrintPdfTemplates() { ensureData(); const raw=readPrintPdfTemplates(); const items=raw.filter((item)=>item?.storedPath && fs.existsSync(item.storedPath)).map((item)=>({ ...item, path:item.storedPath, url:pathToFileURL(item.storedPath).href, previewUrl:item.previewPath && fs.existsSync(item.previewPath) ? pathToFileURL(item.previewPath).href : '' })); if (items.length !== raw.length) writePrintPdfTemplates(items.map(({path,url,previewUrl,...item})=>item)); return { ok:true, items }; }
function findPrintPdfTemplate(id) { const item=readPrintPdfTemplates().find((entry)=>entry.id===String(id)); if (!item?.storedPath || !fs.existsSync(item.storedPath)) throw new Error('نموذج PDF غير موجود في مكتبة الطباعة'); return item; }
function importPrintPdfTemplateFromDialog() { return dialog.showOpenDialog({ title:'إضافة نموذج PDF كامل إلى مصمم الطباعة', properties:['openFile'], filters:[{ name:'نماذج السندات PDF', extensions:['pdf'] }] }).then((selected)=>{ if (selected.canceled || !selected.filePaths[0]) return { canceled:true }; return { ok:true, template:addPrintPdfTemplateFromPath(selected.filePaths[0],{ source:'local' }) }; }); }
async function importPrintPdfTemplateFromWhatsApp(id) { const { item,filePath }=findWhatsAppFile(id); if (String(item.extension).toLowerCase() !== 'pdf') throw new Error('الملف المختار من واتساب ليس PDF'); return { ok:true, template:addPrintPdfTemplateFromPath(filePath,{ source:'whatsapp', name:item.originalName }) }; }
function openPrintPdfTemplate(id) { const item=findPrintPdfTemplate(id); const error=shell.openPath(item.storedPath); return Promise.resolve(error ? { ok:false, error } : { ok:true, path:item.storedPath }); }
function deletePrintPdfTemplate(id) { const item=findPrintPdfTemplate(id); writePrintPdfTemplates(readPrintPdfTemplates().filter((entry)=>entry.id!==String(id))); for (const target of [item.storedPath,item.previewPath]) { if (target) { try { fs.unlinkSync(target); } catch { /* الملف قد يكون محذوفًا مسبقًا */ } } } recordImportExportActivity('delete-template',`تم حذف نموذج PDF: ${item.name}`,item.storedPath); return { ok:true }; }
function savePrintPdfTemplatePreview(id,dataUrl) { const item=findPrintPdfTemplate(id); const saved=saveRenderedPrintReference(dataUrl,item.name); writePrintPdfTemplates(readPrintPdfTemplates().map((entry)=>entry.id===item.id ? { ...entry, previewPath:saved.path } : entry)); return { ok:true, preview:{ ...saved, templateId:item.id } }; }
async function listGoogleDrivePdfFiles() { const session=await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' }; try { const auth=await getDriveAuth(); const drive=google.drive({ version:'v3', auth }); const result=await drive.files.list({ q:"trashed=false and mimeType='application/pdf'", orderBy:'modifiedTime desc', pageSize:100, fields:'files(id,name,mimeType,size,modifiedTime,webViewLink)' }); return { ok:true, files:result.data.files || [] }; } catch (error) { return { ok:false, error:error.message || 'تعذر قراءة ملفات PDF من Google Drive. قد تحتاج إلى إعادة ربط الحساب بصلاحية القراءة.' }; } }
async function importGoogleDrivePdfTemplate(fileId) { const session=await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' }; try { const auth=await getDriveAuth(); const drive=google.drive({ version:'v3', auth }); const meta=await drive.files.get({ fileId:String(fileId), fields:'id,name,mimeType,size,modifiedTime,webViewLink' }); if (meta.data.mimeType !== 'application/pdf') throw new Error('الملف المحدد في Google Drive ليس PDF'); const result=await drive.files.get({ fileId:String(fileId), alt:'media' },{ responseType:'arraybuffer' }); ensureData(); const temporary=path.join(printReferencesDir,`drive-${crypto.randomUUID()}.pdf`); fs.writeFileSync(temporary,Buffer.from(result.data)); const item=addPrintPdfTemplateFromPath(temporary,{ source:'google-drive', name:meta.data.name }); try { fs.unlinkSync(temporary); } catch { /* النسخة الدائمة موجودة */ } return { ok:true, template:item }; } catch (error) { return { ok:false, error:error.message || 'تعذر تنزيل نموذج PDF من Google Drive' }; } }
ipcMain.handle('import-print-reference-image', async () => {
  const session = await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' };
  try {
    const selected=await dialog.showOpenDialog({ title:'استيراد صورة أو PDF سند لتحليل التصميم', properties:['openFile'], filters:[{ name:'صور السندات وPDF', extensions:['png','jpg','jpeg','webp','pdf'] }] });
    if (selected.canceled || !selected.filePaths[0]) return { canceled:true };
    const source=selected.filePaths[0]; const stat=fs.statSync(source); const extension=path.extname(source).toLowerCase();
    if (extension === '.pdf') {
      if (stat.size > 12 * 1024 * 1024) return { ok:false, error:'ملف PDF كبير جدًا؛ الحد الأقصى 12MB' };
      const sample=fs.readFileSync(source); if (sample.subarray(0,5).toString('ascii') !== '%PDF-') return { ok:false, error:'ملف PDF غير صالح' };
      return { ok:true, pdf:{ name:path.basename(source), size:stat.size, mime:'application/pdf', url:pathToFileURL(source).href, source:'pdf' } };
    }
    if (stat.size > 8 * 1024 * 1024) return { ok:false, error:'صورة السند كبيرة جدًا؛ الحد الأقصى 8MB' };
    const sample=fs.readFileSync(source); const detected=detectPrintReferenceMime(sample);
    if (!detected) return { ok:false, error:'صيغة الصورة غير مدعومة؛ استخدم PNG أو JPG أو WEBP فقط' };
    ensureData(); const name=safePrintReferenceName(source);
    const destination=path.join(printReferencesDir,`${Date.now()}-${name}${detected.extension}`);
    fs.copyFileSync(source,destination);
    return { ok:true, image:{ name:path.basename(source), size:stat.size, mime:detected.mime, path:destination, url:pathToFileURL(destination).href } };
  } catch (error) { return { ok:false, error:error.message || 'تعذر استيراد صورة السند' }; }
});
ipcMain.handle('save-rendered-print-reference', async (_event, input = {}) => {
  const session = await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' };
  try { return { ok:true, image:saveRenderedPrintReference(input.dataUrl,input.name) }; }
  catch (error) { return { ok:false, error:error.message || 'تعذر حفظ صفحة PDF المحولة' }; }
});
ipcMain.handle('import-print-pdf-template', async () => { const session=await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' }; try { return await importPrintPdfTemplateFromDialog(); } catch (error) { return { ok:false, error:error.message || 'تعذر استيراد نموذج PDF' }; } });
ipcMain.handle('list-print-pdf-templates', async () => { const session=await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' }; try { return listPrintPdfTemplates(); } catch (error) { return { ok:false, error:error.message || 'تعذر قراءة مكتبة نماذج PDF' }; } });
ipcMain.handle('import-whatsapp-pdf-template', async (_event, id) => { const session=await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' }; try { return await importPrintPdfTemplateFromWhatsApp(id); } catch (error) { return { ok:false, error:error.message || 'تعذر إضافة ملف واتساب كنموذج PDF' }; } });
ipcMain.handle('list-google-drive-pdf-files', async () => { try { return await listGoogleDrivePdfFiles(); } catch (error) { return { ok:false, error:error.message || 'تعذر قراءة ملفات Google Drive' }; } });
ipcMain.handle('import-google-drive-pdf-template', async (_event, fileId) => { try { return await importGoogleDrivePdfTemplate(fileId); } catch (error) { return { ok:false, error:error.message || 'تعذر استيراد نموذج Google Drive' }; } });
ipcMain.handle('open-print-pdf-template', async (_event, id) => { const session=await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' }; try { return await openPrintPdfTemplate(id); } catch (error) { return { ok:false, error:error.message || 'تعذر فتح ملف PDF' }; } });
ipcMain.handle('delete-print-pdf-template', async (_event, id) => { const session=await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' }; try { return deletePrintPdfTemplate(id); } catch (error) { return { ok:false, error:error.message || 'تعذر حذف نموذج PDF' }; } });
ipcMain.handle('save-print-pdf-template-preview', async (_event, input = {}) => { const session=await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' }; try { return savePrintPdfTemplatePreview(input.id,input.dataUrl); } catch (error) { return { ok:false, error:error.message || 'تعذر حفظ معاينة نموذج PDF' }; } });
ipcMain.handle('select-ui-button-logo', async () => {
  const session = await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' };
  try {
    const selected=await dialog.showOpenDialog({ title:'اختيار شعار أو رمز صورة للزر', properties:['openFile'], filters:[{ name:'صور الشعار', extensions:['png','jpg','jpeg','webp'] }] });
    if (selected.canceled || !selected.filePaths[0]) return { canceled:true };
    const source=selected.filePaths[0]; const stat=fs.statSync(source); if (stat.size > 2 * 1024 * 1024) return { ok:false, error:'شعار الزر كبير جدًا؛ الحد الأقصى 2MB' };
    const buffer=fs.readFileSync(source); const detected=detectPrintReferenceMime(buffer); if (!detected) return { ok:false, error:'صيغة الشعار غير مدعومة؛ استخدم PNG أو JPG أو WEBP فقط' };
    ensureData(); const name=safePrintReferenceName(source,'button-logo'); const destination=path.join(uiButtonIconsDir,`${Date.now()}-${name}${detected.extension}`); fs.writeFileSync(destination,buffer);
    return { ok:true, image:{ name:path.basename(source), size:stat.size, mime:detected.mime, url:pathToFileURL(destination).href } };
  } catch (error) { return { ok:false, error:error.message || 'تعذر إضافة شعار الزر' }; }
});
ipcMain.handle('export-print-template', async (_event, input = {}) => {
  const session = await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' };
  try {
    const design=safePrintTemplateDesign(input.design); const name=String(input.name || 'قالب طباعة').replace(/[\\/:*?"<>|]/g,'-').slice(0,80) || 'قالب طباعة';
    const result=await dialog.showSaveDialog({ title:'تصدير قالب الطباعة', defaultPath:`${name}.sarafa-print.json`, filters:[{ name:'قالب طباعة نظام الصراف', extensions:['json'] }] });
    if (result.canceled || !result.filePath) return { canceled:true };
    fs.writeFileSync(result.filePath, JSON.stringify({ format:'sarafa-print-template', version:1, name, exportedAt:new Date().toISOString(), design }, null, 2), 'utf8');
    return { ok:true, path:result.filePath };
  } catch (error) { return { ok:false, error:error.message || 'تعذر تصدير قالب الطباعة' }; }
});
ipcMain.handle('import-print-template', async () => {
  const session = await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' };
  try {
    const selected=await dialog.showOpenDialog({ title:'استيراد قالب طباعة', properties:['openFile'], filters:[{ name:'قالب طباعة نظام الصراف', extensions:['json'] }] });
    if (selected.canceled || !selected.filePaths[0]) return { canceled:true };
    const stat=fs.statSync(selected.filePaths[0]); if (stat.size > 256 * 1024) return { ok:false, error:'ملف القالب كبير جدًا؛ الحد الأقصى 256KB' };
    const raw=JSON.parse(fs.readFileSync(selected.filePaths[0], 'utf8'));
    if (raw?.format !== 'sarafa-print-template' || raw?.version !== 1) return { ok:false, error:'هذا ليس قالب طباعة صالحًا لنظام الصراف' };
    const design=safePrintTemplateDesign(raw.design); const name=String(raw.name || path.basename(selected.filePaths[0], path.extname(selected.filePaths[0]))).slice(0,80);
    return { ok:true, template:{ name, design } };
  } catch (error) { return { ok:false, error:error.message || 'تعذر استيراد قالب الطباعة' }; }
});
ipcMain.handle('open-print-resources', async () => {
  const session = await execute('getSession'); if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' };
  await shell.openExternal('https://fonts.google.com/');
  return { ok:true };
});
ipcMain.handle('db-status', async () => { const result = await query('SELECT 1 AS ok'); const config=getConfig(); return { connected: !result.offline, config:{ host:config.host, port:config.port, database:config.database } }; });
ipcMain.handle('open-module-window', async (event, moduleName) => {
  const view=String(moduleName || 'dashboard');
  if (protectedAdminViews.has(view)) {
    const session=await execute('getSession');
    const saved=JSON.parse(fs.readFileSync(settingsPath,'utf8'));
    const protection=adminMenuProtectionConfig(saved);
    if (!session) return { ok:false, error:'يرجى تسجيل الدخول أولًا' };
    if (!isAdministratorSession(session)) return { ok:false, error:'هذه النافذة متاحة لمدير النظام فقط' };
    if (protection.enabled && !adminMenuUnlocked(event.sender.id,session.id)) return { ok:false, error:'افتح قائمة الإدارة بكلمة مرور المدير أولًا' };
  }
  return openModuleWindow(event, view);
});
ipcMain.handle('open-whatsapp-web', (event) => { try { return openWhatsAppWeb(event); } catch (error) { return { ok:false, error:error.message || 'تعذر فتح واتساب ويب الرسمي' }; } });
ipcMain.handle('import-whatsapp-files', async () => { try { return await importWhatsAppFiles(); } catch (error) { return { ok:false, error:error.message || 'تعذر استيراد الملفات' }; } });
ipcMain.handle('list-whatsapp-files', async () => { try { return await listWhatsAppFiles(); } catch (error) { return { ok:false, error:error.message || 'تعذر قراءة مكتبة الملفات' }; } });
ipcMain.handle('export-whatsapp-file', async (_event, id) => { try { return await exportWhatsAppFile(id); } catch (error) { return { ok:false, error:error.message || 'تعذر تصدير الملف' }; } });
ipcMain.handle('reveal-whatsapp-file', async (_event, id) => { try { return await revealWhatsAppFile(id); } catch (error) { return { ok:false, error:error.message || 'تعذر فتح موقع الملف' }; } });
ipcMain.handle('set-module-window-title', (event, title) => {
  const current = BrowserWindow.fromWebContents(event.sender);
  if (!current || !current.getParentWindow()) return { ok:false, error:'هذه ليست نافذة تشغيل مستقلة' };
  const safe=String(title || 'نافذة عمل').replace(/[\r\n<>]/g,' ').trim().slice(0,100) || 'نافذة عمل';
  current.setTitle(`${safe} — صراف`);
  return { ok:true };
});
ipcMain.handle('apply-window-size', async (event, input = {}) => {
  const session = await execute('getSession');
  if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
  const current = BrowserWindow.fromWebContents(event.sender);
  if (!current) return { ok: false, error: 'تعذر الوصول إلى النافذة الحالية' };
  const isModule = Boolean(current.getParentWindow());
  const minWidth = isModule ? 820 : 1050; const minHeight = isModule ? 580 : 680;
  const width = Math.max(minWidth, Math.min(isModule ? 1800 : 2200, Number(input.width || current.getBounds().width)));
  const height = Math.max(minHeight, Math.min(isModule ? 1300 : 1400, Number(input.height || current.getBounds().height)));
  current.setMinimumSize(minWidth, minHeight);
  current.setSize(Math.round(width), Math.round(height));
  return { ok: true, width: Math.round(width), height: Math.round(height), isModule };
});
ipcMain.handle('close-current-window', (event) => { const current = BrowserWindow.fromWebContents(event.sender); if (current && current.getParentWindow()) { current.close(); return { ok: true }; } return { ok: false }; });
ipcMain.handle('data-call', async (event, operation, input) => {
  try {
    if (!['login', 'getSession', 'logout'].includes(operation)) {
      const session = await execute('getSession');
      if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
    }
    const data=await execute(operation, input);
    if (operation==='logout') { adminMenuUnlocks.delete(event.sender.id); connectionSettingsUnlocks.delete(event.sender.id); }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error.message || 'تعذر إتمام العملية' };
  }
});
const backupTables = ['currencies', 'accounts', 'branches', 'users', 'cashboxes', 'customers', 'transfers', 'journal_entries', 'journal_lines', 'audit_log', 'app_settings', 'exchange_operations', 'cash_currency_purchases', 'cash_purchase_totals', 'user_permissions', 'vouchers', 'cashbox_accounts', 'cashbox_counts', 'transfer_journals', 'employees', 'user_groups', 'group_permissions', 'user_devices', 'financial_periods', 'transfer_payouts'];

async function buildBackupPayload() {
  const db = await connect();
  if (!db) throw new Error('تعذر الاتصال بـ MySQL لإنشاء النسخة الاحتياطية');
  const [availableRows] = await db.query('SHOW TABLES');
  const available = new Set(availableRows.map((row) => Object.values(row)[0]));
  const tables = {};
  for (const table of backupTables) { if (available.has(table)) { const [tableRows] = await db.query(`SELECT * FROM \`${table}\``); tables[table] = tableRows; } }
  return { format: 'sarafa-local-backup', version: 1, createdAt: new Date().toISOString(), settings: JSON.parse(fs.readFileSync(settingsPath, 'utf8')), tables };
}

async function restoreBackupPayload(backup) {
  if (backup?.format !== 'sarafa-local-backup' || !backup.tables || typeof backup.tables !== 'object') throw new Error('هذا الملف ليس نسخة نظام الصراف المحلية');
  const db = await connect();
  if (!db) throw new Error('تعذر الاتصال بـ MySQL لاستعادة النسخة');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('SET FOREIGN_KEY_CHECKS=0');
    for (const table of [...backupTables].reverse()) if (Array.isArray(backup.tables[table])) await connection.query(`DELETE FROM \`${table}\``);
    for (const table of backupTables) {
      const records = backup.tables[table];
      if (!Array.isArray(records) || !records.length) continue;
      const columns = Object.keys(records[0]);
      const sql = `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
      for (const record of records) await connection.execute(sql, columns.map((column) => record[column]));
    }
    await connection.query('SET FOREIGN_KEY_CHECKS=1');
    await connection.commit();
    if (backup.settings) { fs.writeFileSync(settingsPath, JSON.stringify(backup.settings, null, 2)); configure(backup.settings.database); }
    return { ok: true };
  } catch (error) { await connection.rollback(); try { await connection.query('SET FOREIGN_KEY_CHECKS=1'); } catch { /* cleanup */ } throw error; } finally { connection.release(); }
}

async function getDriveAuth() {
  if (!fs.existsSync(driveClientPath)) throw new Error('اربط حساب Google أولًا باختيار ملف client_secret JSON');
  const config = JSON.parse(fs.readFileSync(driveClientPath, 'utf8')).installed;
  if (!config?.client_id || !config?.client_secret) throw new Error('ملف تفويض Google Drive غير صالح');
  const oauth = new google.auth.OAuth2(config.client_id, config.client_secret, 'http://127.0.0.1');
  if (!fs.existsSync(driveTokenPath)) throw new Error('لم يكتمل تسجيل الدخول إلى حساب Google بعد');
  oauth.setCredentials(JSON.parse(fs.readFileSync(driveTokenPath, 'utf8')));
  return oauth;
}

const sheetsDesignerScopes = ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/spreadsheets'];
const sheetsDesignerProtectedButtons = new Set(['dashboard', 'layout-controls', 'sheets-designer', 'admin']);
const sheetsDesignerProtectedFields = {
  'voucher-receipt':['voucherDate','voucherType','voucherCurrency','voucherCashbox','voucherCounterAccount','voucherAmount'],
  'voucher-payment':['voucherDate','voucherType','voucherCurrency','voucherCashbox','voucherCounterAccount','voucherAmount'],
  'transfers-incoming':['transferType','transferCurrency','transferAmount','transferCashbox','transferCounterAccount','transferDate'],
  'transfers-outgoing':['transferType','transferCurrency','transferAmount','transferCashbox','transferCounterAccount','transferDate'],
  'exchange-buy':['exchangeType','exchangeCurrency','exchangeCashbox','exchangeCounterAccount','exchangeDate','foreignAmount','dealRate'],
  'exchange-sell':['exchangeType','exchangeCurrency','exchangeCashbox','exchangeCounterAccount','exchangeDate','foreignAmount','dealRate'],
  'simple-entries':['simpleCurrency','simpleAmount','simpleDebit','simpleCredit','simpleDate'],
  'quick-entry':['quickOperation','quickCashbox','quickCurrency','quickAmount'],
  'account-statement':['statementTargetType','statementTarget','statementFrom','statementTo','statementCurrency'],
  'trial-balance':['trialFrom','trialTo'],
  'general-journal':['journalFrom','journalTo'],
  'income-expense-report':['incomeExpenseFrom','incomeExpenseTo'],
  'operations-today':['operationsDate']
};
const sheetsDesignerOperations = {
  'voucher-receipt': { fields:['voucherAutoNo','voucherDate','voucherType','voucherCurrency','voucherCashbox','voucherCounterAccount','voucherAmount','voucherParty','voucherReference','voucherNotes'], columns:['رقم السند','الدافع','الصندوق','المبلغ','وقت التنفيذ','الحالة','إجراء'] },
  'voucher-payment': { fields:['voucherAutoNo','voucherDate','voucherType','voucherCurrency','voucherCashbox','voucherCounterAccount','voucherAmount','voucherParty','voucherReference','voucherNotes'], columns:['رقم السند','المستلم','الصندوق','المبلغ','وقت التنفيذ','الحالة','إجراء'] },
  'transfers-incoming': { fields:['transferType','transferCurrency','transferAmount','senderName','senderPhone','beneficiaryName','beneficiaryPhone','transferAgent','transferCommission','transferCashbox','transferCounterAccount','transferDate','transferNotes'], columns:['رقم الحوالة','النوع','المرسل','المستفيد','المبلغ','وقت التنفيذ','الحالة'] },
  'transfers-outgoing': { fields:['transferType','transferCurrency','transferAmount','senderName','senderPhone','beneficiaryName','beneficiaryPhone','transferAgent','transferCommission','transferCashbox','transferCounterAccount','transferDate','transferNotes'], columns:['رقم الحوالة','النوع','المرسل','المستفيد','المبلغ','وقت التنفيذ','الحالة'] },
  'exchange-buy': { fields:['exchangeType','exchangeCurrency','exchangeCashbox','exchangeCounterAccount','exchangeCustomer','exchangeDate','foreignAmount','dealRate','localAmount','handling','exchangeNotes'], columns:['رقم العملية','النوع','العملة','المبلغ','السعر','المقابل','وقت التنفيذ','الحالة'] },
  'exchange-sell': { fields:['exchangeType','exchangeCurrency','exchangeCashbox','exchangeCounterAccount','exchangeCustomer','exchangeDate','foreignAmount','dealRate','localAmount','handling','exchangeNotes'], columns:['رقم العملية','النوع','العملة','المبلغ','السعر','المقابل','وقت التنفيذ','الحالة'] },
  'simple-entries': { fields:['simpleCurrency','simpleAmount','simpleDebit','simpleCredit','simpleDate','simpleNotes'], columns:['رقم القيد','وقت التنفيذ','البيان','المصدر','الحالة'] },
  'quick-entry': { fields:['quickOperation','quickCashbox','quickAccount','quickCurrency','quickAmount','quickNotes'], columns:[] },
  'account-statement': { fields:['statementTargetType','statementTarget','statementFrom','statementTo','statementCurrency'], columns:['التاريخ','رقم القيد','المصدر','البيان','مدين','دائن','الرصيد','العملة'] },
  'trial-balance': { fields:['trialFrom','trialTo'], columns:['رقم الحساب','اسم الحساب','مدين','دائن','الرصيد','العملة'] },
  'general-journal': { fields:['journalFrom','journalTo'], columns:['رقم القيد','التاريخ','البيان','مدين','دائن','الحالة'] },
  'income-expense-report': { fields:['incomeExpenseFrom','incomeExpenseTo'], columns:['التصنيف','رقم الحساب','الحساب','المبلغ','عدد القيود'] },
  'operations-today': { fields:['operationsDate'], columns:['وقت التنفيذ','النوع','رقم العملية','التفاصيل','المبلغ','العملة','الحالة'] }
};
const sheetsDesignerExternalSurfaces = ['dashboard','settings','reports','management-reports','accounts','customers','currency-settings','cashboxes','backup-center','user-access','groups','device-access','employees','financial-controls','alerts','audit-log','account-statement','trial-balance','general-journal','operations-today','print-settings','layout-controls','print-designer','ui-designer','window-designer','design-library'];
const sheetsDesignerWindowKeys = new Set(['width','height','minWidth','minHeight','title','formPosition','tablePosition','formColumns','contentWidth','formAlign','tableAlign','windowBg','formBg','tableBg','accent','textColor','formFontSize','tableFontSize','buttonColor','buttonRadius','buttonFontSize','actionPosition','sectionOrder']);
const sheetsDesignerTableKeys = new Set(['rowHeight','tableFontSize','headerColor','rowColor','borderColor','columnWidth']);
const sheetsDesignerUiKeys = new Set(['mainWidth','mainHeight','moduleWidth','moduleHeight','appBackground','toolbarStart','toolbarEnd','toolbarText','toolbarHeight','toolbarButtonWidth','toolbarButtonFont','toolbarGap','toolbarRadius']);

function isSheetsDesignerAdmin(session) { return Number(session?.id) === 1 || /مدير|admin/i.test(String(session?.roleName || session?.role || '')); }
async function requireSheetsDesignerAdmin() { const session = await execute('getSession'); if (!session) throw new Error('يرجى تسجيل الدخول أولًا'); if (!isSheetsDesignerAdmin(session)) throw new Error('مصمم Google Sheets متاح لمدير النظام فقط'); return session; }
function sheetsCellText(value, max = 180) { return String(value ?? '').replace(/[\r\n\t]/g, ' ').trim().slice(0, max); }
function sheetsColor(value) { const color=sheetsCellText(value,16); return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : ''; }
function sheetsNumber(value, min, max) { const number=Number(value); return Number.isFinite(number) ? Math.max(min,Math.min(max,number)) : null; }
function sheetsBoolean(value) { const normalized=sheetsCellText(value,16).toLowerCase(); if (['true','yes','1','نعم','ظاهر','مفعّل'].includes(normalized)) return true; if (['false','no','0','لا','مخفي','معطل'].includes(normalized)) return false; return null; }
function spreadsheetIdFromInput(input) { const value=sheetsCellText(input,500); const id=value.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/)?.[1] || (/^[a-zA-Z0-9_-]{20,}$/.test(value) ? value : ''); if (!id) throw new Error('ضع رابط Google Sheets الصحيح أو معرّف الملف'); return id; }
function sheetsTabName(name) { return `'${String(name).replace(/'/g,"''")}'`; }
function sheetDesignRows() {
  const rows=[['Scope','Target','ElementType','ElementKey','Property','Value','Order','Note'],['GLOBAL','system','app','main','mainWidth','1280','','عرض نافذة النظام'],['GLOBAL','system','app','main','mainHeight','820','','ارتفاع نافذة النظام'],['GLOBAL','system','app','main','appBackground','#eef3f8','','خلفية النظام'],['GLOBAL','toolbar','toolbar','main','toolbarStart','#447cad','','بداية تدرج الشريط'],['GLOBAL','toolbar','toolbar','main','toolbarEnd','#285d91','','نهاية تدرج الشريط'],['GLOBAL','toolbar','toolbar','main','toolbarText','#f7fbff','','لون نصوص الشريط'],['GLOBAL','toolbar','toolbar','main','toolbarHeight','57','','ارتفاع الشريط'],['GLOBAL','appearance','appearance','main','font','Cairo, Tahoma, Arial, sans-serif','','الخط العام'],['GLOBAL','appearance','appearance','main','fontSize','14','','حجم خط الواجهة']];
  ['dashboard','layout-controls','sheets-designer','admin','quick-entry','operations-today','new-exchange','exchange-buy','exchange-sell','voucher-payment','voucher-receipt','transfers-outgoing','transfers-incoming','simple-entries','accounts','reports','currency-settings'].forEach((key,index) => rows.push(['GLOBAL','toolbar','button',key,'visible','TRUE',String(index + 1),'TRUE أو FALSE؛ الأزرار الحرجة تبقى ظاهرة']));
  sheetsDesignerExternalSurfaces.forEach((target) => { rows.push(['SURFACE',target,'window','surface','windowBg','#eef3f8','','خلفية النافذة الخارجية'],['SURFACE',target,'window','surface','textColor','#173651','','لون نصوص النافذة'],['SURFACE',target,'window','surface','accent','#356e9f','','اللون الرئيسي'],['SURFACE',target,'table','all','headerColor','#b9cbe8','','ترويسة الجداول'],['SURFACE',target,'table','all','rowColor','#fff9f9','','صفوف الجداول'],['SURFACE',target,'table','all','rowHeight','29','','ارتفاع صفوف الجداول']); });
  Object.entries(sheetsDesignerOperations).forEach(([target,spec]) => { ['width','height','title','windowBg','formBg','tableBg','accent','textColor','formColumns','formFontSize','tableFontSize','buttonColor','buttonRadius','contentWidth','formPosition','tablePosition','actionPosition'].forEach((property) => rows.push(['OPERATION',target,'window','window',property,property === 'width' ? '1060' : property === 'height' ? '740' : property === 'formColumns' ? '3' : property === 'contentWidth' ? '100' : property === 'formPosition' || property === 'tablePosition' || property === 'actionPosition' ? 'top' : property.includes('Bg') ? '#eef3f8' : property === 'accent' || property === 'buttonColor' ? '#356e9f' : property === 'textColor' ? '#173651' : property.includes('Font') ? '13' : property === 'buttonRadius' ? '5' : '', '', 'خصائص نافذة العملية'])); ['rowHeight','tableFontSize','headerColor','rowColor','borderColor'].forEach((property) => rows.push(['OPERATION',target,'table','operations',property,property === 'rowHeight' ? '29' : property === 'tableFontSize' ? '10' : property === 'headerColor' ? '#b9cbe8' : property === 'rowColor' ? '#fff9f9' : '#bb4654','','خصائص جدول العملية'])); spec.fields.forEach((key,index) => rows.push(['OPERATION',target,'field',key,'visible','TRUE',String(index + 1),'أعد التسمية عبر Property=label؛ الحقول المحاسبية تبقى ظاهرة'])); spec.columns.forEach((key,index) => rows.push(['OPERATION',target,'column',key,'width','',String(index + 1),'عرض العمود بالبكسل: 70 إلى 500'])); });
  return rows;
}
function sheetInstructionsRows() { return [['مصمم Google Sheets — نظام الصراف'],['طريقة الاستخدام','عدّل القيم داخل ورقة CONTROLS فقط، ثم اختر تحديث من Sheets داخل النظام، وافحص المعاينة ثم اعتمد التطبيق.'],['النطاق الآمن','تُقبل إعدادات المظهر والترتيب والأحجام والعناوين فقط. لا توجد أي خلية تعدّل MySQL أو الأرصدة أو القيود.'],['الحماية','لا يمكن إخفاء الرئيسية أو الإدارة أو لوحة التحكم أو مصمم Sheets، ولا حقول الحفظ والترحيل والمبلغ والصندوق والحساب والتاريخ الأساسية.'],['القيم','الألوان بصيغة #RRGGBB؛ الإظهار TRUE/FALSE أو نعم/لا؛ العرض 70-500؛ والأحجام ضمن الحدود الظاهرة في النظام.'],['الاستعادة','يحتفظ النظام بنسخة ما قبل Sheets وسجل استيراد. استخدم استعادة ما قبل Sheets أو استعادة نسخة محفوظة عند الحاجة.']]; }
function safeSheetsDesignerDesign(values) {
  const rows=Array.isArray(values) ? values : []; const header=(rows[0] || []).map((item) => sheetsCellText(item,40).toLowerCase()); const column=(name) => header.indexOf(name.toLowerCase()); const index={ scope:column('Scope'), target:column('Target'), type:column('ElementType'), key:column('ElementKey'), property:column('Property'), value:column('Value'), order:column('Order') }; if (Object.values(index).some((item) => item < 0)) throw new Error('ورقة CONTROLS يجب أن تحتوي رؤوس الأعمدة الأصلية: Scope, Target, ElementType, ElementKey, Property, Value, Order');
  const design={ ui:{}, appearance:{}, surfaces:{}, windowTargets:{}, tableTargets:{}, warnings:[], importedRows:0 };
  const external=new Set(sheetsDesignerExternalSurfaces); const operations=new Set(Object.keys(sheetsDesignerOperations)); const write=(object,key,value) => { if (value !== null && value !== '' && value !== undefined) object[key]=value; };
  const windowValue=(property,value) => { if (['windowBg','formBg','tableBg','accent','textColor','buttonColor'].includes(property)) return sheetsColor(value); if (['width','height','minWidth','minHeight'].includes(property)) return sheetsNumber(value,property.includes('Width') ? 720 : 520,property.includes('Width') ? 1800 : 1300); if (['formColumns'].includes(property)) return sheetsNumber(value,1,4); if (['contentWidth'].includes(property)) return sheetsNumber(value,70,100); if (['formFontSize','tableFontSize','buttonFontSize'].includes(property)) return sheetsNumber(value,8,24); if (property === 'buttonRadius') return sheetsNumber(value,0,18); if (['formPosition','tablePosition','actionPosition'].includes(property)) return ['top','bottom'].includes(sheetsCellText(value,20)) ? sheetsCellText(value,20) : null; if (['formAlign','tableAlign'].includes(property)) return ['right','center','left'].includes(sheetsCellText(value,20)) ? sheetsCellText(value,20) : null; if (property === 'title') return sheetsCellText(value,100); return null; };
  rows.slice(1).forEach((row,rowNumber) => { const scope=sheetsCellText(row[index.scope],24).toUpperCase(); const target=sheetsCellText(row[index.target],80); const type=sheetsCellText(row[index.type],24).toLowerCase(); const key=sheetsCellText(row[index.key],100); const property=sheetsCellText(row[index.property],40); const value=row[index.value]; const order=sheetsNumber(row[index.order],1,999); if (!scope || !target || !type || !property) return; design.importedRows += 1;
    if (scope === 'GLOBAL' && target === 'system' && type === 'app' && sheetsDesignerUiKeys.has(property)) { const parsed=['mainWidth','moduleWidth'].includes(property) ? sheetsNumber(value,820,2200) : ['mainHeight','moduleHeight'].includes(property) ? sheetsNumber(value,580,1400) : property === 'appBackground' ? sheetsColor(value) : null; write(design.ui,property,parsed); return; }
    if (scope === 'GLOBAL' && target === 'toolbar' && type === 'toolbar' && sheetsDesignerUiKeys.has(property)) { const parsed=['toolbarStart','toolbarEnd','toolbarText'].includes(property) ? sheetsColor(value) : ['toolbarHeight'].includes(property) ? sheetsNumber(value,40,100) : ['toolbarButtonWidth'].includes(property) ? sheetsNumber(value,55,210) : ['toolbarButtonFont'].includes(property) ? sheetsNumber(value,8,24) : property === 'toolbarGap' ? sheetsNumber(value,0,20) : property === 'toolbarRadius' ? sheetsNumber(value,0,18) : null; write(design.ui,property,parsed); return; }
    if (scope === 'GLOBAL' && target === 'appearance' && type === 'appearance') { const parsed=property === 'font' ? sheetsCellText(value,180).replace(/[^a-zA-Z0-9\s,\-_'.\u0600-\u06FF]/g,'') : property === 'color' ? sheetsColor(value) : ['fontSize','tableFontSize'].includes(property) ? sheetsNumber(value,8,24) : null; write(design.appearance,property,parsed); return; }
    if (scope === 'GLOBAL' && target === 'toolbar' && type === 'button') { const allowed=['label','icon','color','visible','enabled','order']; if (!allowed.includes(property) || !key) return; design.ui.buttons=design.ui.buttons || {}; const button=design.ui.buttons[key] || {}; if (property === 'label') write(button,'label',sheetsCellText(value,80)); else if (property === 'icon') write(button,'icon',sheetsCellText(value,3)); else if (property === 'color') write(button,'color',sheetsColor(value)); else if (property === 'order') write(button,'order',order); else { const visible=sheetsBoolean(value); if (sheetsDesignerProtectedButtons.has(key) && visible === false) { button.visible=true; design.warnings.push(`تم إبقاء زر ${key} ظاهرًا لأنه محمي`); } else write(button,property,visible); } design.ui.buttons[key]=button; return; }
    if (!operations.has(target) && !external.has(target)) { design.warnings.push(`تم تجاهل الصف ${rowNumber + 2}: الهدف ${target} غير معتمد`); return; }
    if (type === 'window') { const parsed=windowValue(property,value); if (parsed === null || !sheetsDesignerWindowKeys.has(property)) { design.warnings.push(`تم تجاهل خاصية نافذة غير معتمدة في الصف ${rowNumber + 2}`); return; } const bucket=operations.has(target) ? design.windowTargets : design.surfaces; bucket[target]=bucket[target] || {}; write(bucket[target],property,parsed); return; }
    if (type === 'table') { const parsed=['headerColor','rowColor','borderColor'].includes(property) ? sheetsColor(value) : property === 'rowHeight' ? sheetsNumber(value,22,60) : property === 'tableFontSize' ? sheetsNumber(value,8,24) : property === 'columnWidth' ? sheetsNumber(value,70,500) : null; if (parsed === null || !sheetsDesignerTableKeys.has(property)) { design.warnings.push(`تم تجاهل خاصية جدول غير معتمدة في الصف ${rowNumber + 2}`); return; } if (operations.has(target)) { design.tableTargets[target]=design.tableTargets[target] || {}; write(design.tableTargets[target],property,parsed); } else { design.surfaces[target]=design.surfaces[target] || {}; design.surfaces[target].table={ ...(design.surfaces[target].table || {}), [property]:parsed }; } return; }
    if (!operations.has(target)) { design.warnings.push(`تم تجاهل صف حقول أو أعمدة خارجي في الصف ${rowNumber + 2}`); return; }
    const spec=sheetsDesignerOperations[target]; if (type === 'field' && spec.fields.includes(key)) { const protectedField=sheetsDesignerProtectedFields[target]?.includes(key); const parsed=property === 'label' ? sheetsCellText(value,100) : property === 'visible' ? sheetsBoolean(value) : property === 'order' ? order : null; if (parsed === null) return; if (property === 'visible' && protectedField && parsed === false) { design.warnings.push(`تم إبقاء الحقل ${key} ظاهرًا لأنه محاسبي محمي`); return; } design.windowTargets[target]=design.windowTargets[target] || {}; design.windowTargets[target].fields=design.windowTargets[target].fields || {}; design.windowTargets[target].fields[key]={ ...(design.windowTargets[target].fields[key] || {}), [property]:parsed }; return; }
    if (type === 'column' && spec.columns.includes(key)) { const parsed=property === 'label' ? sheetsCellText(value,100) : property === 'visible' ? sheetsBoolean(value) : property === 'width' ? sheetsNumber(value,70,500) : property === 'order' ? order : null; if (parsed === null) return; design.tableTargets[target]=design.tableTargets[target] || {}; design.tableTargets[target].columns=design.tableTargets[target].columns || {}; design.tableTargets[target].columns[key]={ ...(design.tableTargets[target].columns[key] || {}), [property]:parsed }; }
  });
  return design;
}
async function sheetsDesignerClient() { const auth=await getDriveAuth(); return google.sheets({ version:'v4', auth }); }
function sheetsExportTables(data, scope) { const include=(group) => scope === 'all' || scope === group; const table=(title,header,source,map) => ({ title,values:[header,...(source || []).map(map)] }); const tables=[]; if (include('masters')) { tables.push(table('الحسابات',['الرمز','اسم الحساب','النوع','الحالة'],data.accounts,(item) => [item.code,item.name_ar,item.account_type,item.active ? 'نشط' : 'موقوف'])); tables.push(table('العملاء',['رقم العميل','الاسم','الهاتف','النوع','الحالة'],data.customers,(item) => [item.customer_no,item.full_name,item.phone || '',item.customer_type,item.active ? 'نشط' : 'موقوف'])); tables.push(table('الصناديق',['الصندوق','الفرع','الحساب','الحالة'],data.cashboxes,(item) => [item.name_ar,item.branch_name || '',item.account_name || '',item.active ? 'نشط' : 'موقوف'])); tables.push(table('العملات',['الرمز','العملة','شراء','بيع','الحالة'],data.currencies,(item) => [item.code,item.name_ar,item.buy_rate,item.sell_rate,item.active ? 'نشط' : 'موقوف'])); } if (include('operations')) { tables.push(table('السندات',['رقم السند','النوع','التاريخ','الطرف','المناولة','الصندوق','العملة','المبلغ','الحالة','البيان'],data.vouchers,(item) => [item.voucher_no,item.voucher_type === 'receipt' ? 'سند قبض' : 'سند صرف',String(item.voucher_date || '').slice(0,10),item.party_name || '',item.handler_name || '',item.cashbox_name || '',item.currency_code || '',item.amount,item.status,item.notes || ''])); tables.push(table('الحوالات',['رقم الحوالة','النوع','التاريخ','المرسل','المستفيد','العملة','المبلغ','العمولة','الحالة'],data.transfers,(item) => [item.transfer_no,item.transfer_type === 'incoming' ? 'واردة' : 'صادرة',String(item.transfer_date || item.created_at || '').slice(0,10),item.sender_name || '',item.beneficiary_name || '',item.currency_code || '',item.amount,item.commission || 0,item.status])); tables.push(table('الصرافة',['رقم العملية','النوع','التاريخ','العملة','المبلغ','السعر','القيمة المحلية','الحالة'],data.exchanges,(item) => [item.operation_no,item.operation_type === 'buy' ? 'شراء' : 'بيع',String(item.operation_date || '').slice(0,10),item.currency_code || '',item.amount,item.deal_rate,item.local_value,item.status])); } return tables; }
async function syncSarafaDataToSheets(input = {}) { const session=await execute('getSession'); if (!session) throw new Error('يرجى تسجيل الدخول أولًا'); const scope=['all','masters','operations'].includes(input.scope) ? input.scope : 'all'; const sheets=await sheetsDesignerClient(); let spreadsheetId=String(input.spreadsheetId || '').trim(); let created=false; let spreadsheetUrl=''; let title=''; if (!spreadsheetId) { const made=await sheets.spreadsheets.create({ requestBody:{ properties:{ title:`نسخة بيانات الصرافة ${new Date().toISOString().slice(0,10)}` } } }); spreadsheetId=made.data.spreadsheetId; spreadsheetUrl=made.data.spreadsheetUrl || ''; title=made.data.properties?.title || ''; created=true; } else spreadsheetId=spreadsheetIdFromInput(spreadsheetId); const data=await execute('bootstrap'); const tables=sheetsExportTables(data,scope); const meta=await sheets.spreadsheets.get({ spreadsheetId, fields:'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties' }); spreadsheetUrl=spreadsheetUrl || meta.data.spreadsheetUrl || ''; title=title || meta.data.properties?.title || 'Google Sheets'; const existing=new Set((meta.data.sheets || []).map((sheet) => sheet.properties?.title)); const requests=tables.filter((item) => !existing.has(item.title)).map((item) => ({ addSheet:{ properties:{ title:item.title } } })); if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody:{ requests } }); for (const item of tables) { const safe=item.title.replace(/'/g,"''"); await sheets.spreadsheets.values.clear({ spreadsheetId, range:`'${safe}'!A:ZZ` }); await sheets.spreadsheets.values.update({ spreadsheetId, range:`'${safe}'!A1`, valueInputOption:'RAW', requestBody:{ values:item.values } }); } return { spreadsheetId, spreadsheetUrl, title, scope, created, tables:tables.map((item) => ({ title:item.title, rows:Math.max(0,item.values.length-1) })), syncedAt:new Date().toISOString() }; }
async function createSheetsDesignerTemplate() { const sheets=await sheetsDesignerClient(); return createVisualSheetsDesignerTemplate({ sheets,title:`Sarafa Visual Designer ${new Date().toISOString().slice(0,10)}`,operations:sheetsDesignerOperations,externalSurfaces:sheetsDesignerExternalSurfaces }); }
async function upgradeSheetsDesignerTemplate(rawSpreadsheetId) { const spreadsheetId=spreadsheetIdFromInput(rawSpreadsheetId); const sheets=await sheetsDesignerClient(); return upgradeVisualSheetsDesignerTemplate({ sheets,spreadsheetId,operations:sheetsDesignerOperations,externalSurfaces:sheetsDesignerExternalSurfaces }); }

async function getSarafaDriveFolder(drive) {
  const found = await drive.files.list({ q: "name='Sarafa Backups' and mimeType='application/vnd.google-apps.folder' and trashed=false", fields: 'files(id,name)' });
  if (found.data.files?.[0]?.id) return found.data.files[0].id;
  const created = await drive.files.create({ requestBody: { name: 'Sarafa Backups', mimeType: 'application/vnd.google-apps.folder' }, fields: 'id' });
  return created.data.id;
}

ipcMain.handle('backup-data', async () => {
  const session = await execute('getSession');
  if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
  const result = await dialog.showSaveDialog({ title: 'حفظ نسخة احتياطية كاملة', defaultPath: `sarafa-backup-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (result.canceled || !result.filePath) return { canceled: true };
  const db = await connect();
  if (!db) return { ok: false, error: 'تعذر الاتصال بـ MySQL لإنشاء النسخة الاحتياطية' };
  const [availableRows] = await db.query('SHOW TABLES');
  const available = new Set(availableRows.map((row) => Object.values(row)[0]));
  const tables = {};
  for (const table of backupTables) {
    if (!available.has(table)) continue;
    const [tableRows] = await db.query(`SELECT * FROM \`${table}\``);
    tables[table] = tableRows;
  }
  fs.writeFileSync(result.filePath, JSON.stringify({ format: 'sarafa-local-backup', version: 1, createdAt: new Date().toISOString(), settings: JSON.parse(fs.readFileSync(settingsPath, 'utf8')), tables }, null, 2), 'utf8');
  return { ok: true, path: result.filePath, tableCount: Object.keys(tables).length };
});

ipcMain.handle('restore-data', async () => {
  const session = await execute('getSession');
  if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
  const selected = await dialog.showOpenDialog({ title: 'اختيار نسخة احتياطية للاستعادة', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  let backup;
  try { backup = JSON.parse(fs.readFileSync(selected.filePaths[0], 'utf8')); } catch { return { ok: false, error: 'ملف النسخة الاحتياطية غير صالح' }; }
  if (backup?.format !== 'sarafa-local-backup' || !backup.tables || typeof backup.tables !== 'object') return { ok: false, error: 'هذا الملف ليس نسخة نظام الصراف المحلية' };
  const confirmation = await dialog.showMessageBox({ type: 'warning', buttons: ['إلغاء', 'استعادة الآن'], defaultId: 0, cancelId: 0, title: 'تأكيد الاستعادة', message: 'سيتم استبدال بيانات الجداول الموجودة ببيانات النسخة الاحتياطية. هل تريد المتابعة؟' });
  if (confirmation.response !== 1) return { canceled: true };
  const db = await connect();
  if (!db) return { ok: false, error: 'تعذر الاتصال بـ MySQL لاستعادة النسخة' };
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('SET FOREIGN_KEY_CHECKS=0');
    for (const table of [...backupTables].reverse()) {
      if (Array.isArray(backup.tables[table])) await connection.query(`DELETE FROM \`${table}\``);
    }
    for (const table of backupTables) {
      const records = backup.tables[table];
      if (!Array.isArray(records) || !records.length) continue;
      const columns = Object.keys(records[0]);
      const sql = `INSERT INTO \`${table}\` (${columns.map((column) => `\`${column}\``).join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
      for (const record of records) await connection.execute(sql, columns.map((column) => record[column]));
    }
    await connection.query('SET FOREIGN_KEY_CHECKS=1');
    await connection.commit();
    if (backup.settings) { fs.writeFileSync(settingsPath, JSON.stringify(backup.settings, null, 2)); configure(backup.settings.database); }
    return { ok: true, path: selected.filePaths[0] };
  } catch (error) {
    await connection.rollback();
    try { await connection.query('SET FOREIGN_KEY_CHECKS=1'); } catch { /* ignore cleanup error */ }
    return { ok: false, error: error.message || 'تعذرت استعادة النسخة الاحتياطية' };
  } finally { connection.release(); }
});

ipcMain.handle('save-pdf', async (event, options = {}) => {
  const session = await execute('getSession');
  if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
  const result = await chooseExportDestination(`sarafa-report-${new Date().toISOString().slice(0, 10)}.pdf`,'حفظ التقرير بصيغة PDF',[{ name: 'PDF', extensions: ['pdf'] }]);
  if (result.canceled || !result.filePath) return { canceled: true };
  const pageSize = ['A4', 'A5', 'Letter'].includes(options.paperSize) ? options.paperSize : 'A4';
  fs.writeFileSync(result.filePath, await event.sender.printToPDF({ printBackground: true, landscape: options.orientation === 'landscape', pageSize }));
  recordImportExportActivity('export','تم تصدير تقرير PDF',result.filePath);
  return { ok: true, path: result.filePath };
});

ipcMain.handle('export-excel', async () => {
  const session = await execute('getSession');
  if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
  const result = await chooseExportDestination(`sarafa-export-${new Date().toISOString().slice(0, 10)}.xlsx`,'تصدير بيانات إلى Excel',[{ name: 'Excel', extensions: ['xlsx'] }]);
  if (result.canceled || !result.filePath) return { canceled: true };
  const db = await connect();
  if (!db) return { ok: false, error: 'تعذر الاتصال بـ MySQL للتصدير' };
  const workbook = XLSX.utils.book_new();
  for (const [sheetName, table] of Object.entries({ الحسابات: 'accounts', العملاء: 'customers', العملات: 'currencies', الصناديق: 'cashboxes', الحوالات: 'transfers', السندات: 'vouchers', الصرافة: 'exchange_operations' })) {
    const [rows] = await db.query(`SELECT * FROM \`${table}\``);
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), sheetName);
  }
  XLSX.writeFile(workbook, result.filePath);
  recordImportExportActivity('export','تم تصدير بيانات النظام إلى Excel',result.filePath);
  return { ok: true, path: result.filePath };
});

ipcMain.handle('export-income-expense-report', async (_event, input = {}) => {
  const session = await execute('getSession');
  if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
  try {
    const report = await execute('incomeExpenseReport', { dateFrom: input.dateFrom, dateTo: input.dateTo });
    const result = await chooseExportDestination(`income-expense-${report.dateFrom}-${report.dateTo}.xlsx`,'تصدير تقرير الإيرادات والمصروفات',[{ name: 'Excel', extensions: ['xlsx'] }]);
    if (result.canceled || !result.filePath) return { canceled: true };
    const workbook = XLSX.utils.book_new();
    const summary = [
      { البيان:'الفترة من', القيمة:report.dateFrom }, { البيان:'الفترة إلى', القيمة:report.dateTo },
      { البيان:'إجمالي الإيرادات', القيمة:Number(report.income || 0) }, { البيان:'إجمالي المصروفات', القيمة:Number(report.expense || 0) },
      { البيان:'صافي النتيجة', القيمة:Number(report.net || 0) },
      { البيان:'الفترة المقارنة من', القيمة:report.comparison?.dateFrom || '' }, { البيان:'الفترة المقارنة إلى', القيمة:report.comparison?.dateTo || '' },
      { البيان:'صافي الفترة السابقة', القيمة:Number(report.comparison?.net || 0) }, { البيان:'تغير صافي النتيجة', القيمة:Number(report.comparison?.netChange || 0) }
    ];
    const details = (report.rows || []).map((row) => ({ التصنيف:row.account_type === 'income' ? 'إيراد' : 'مصروف', 'رقم الحساب':row.code, الحساب:row.name_ar, المبلغ:Number(row.amount || 0), 'عدد القيود':Number(row.entry_count || 0) }));
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summary), 'الملخص');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(details), 'تفاصيل الحسابات');
    XLSX.writeFile(workbook, result.filePath);
    recordImportExportActivity('export','تم تصدير تقرير الإيرادات والمصروفات',result.filePath);
    return { ok: true, path:result.filePath, rows:details.length };
  } catch (error) { return { ok:false, error:error.message || 'تعذر تصدير التقرير المالي' }; }
});

ipcMain.handle('import-excel', async () => {
  const session = await execute('getSession');
  if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
  const folders=importExportCenterSettings();
  const selected = await dialog.showOpenDialog({ title: 'استيراد بيانات Excel', defaultPath:folders.importFolder, properties: ['openFile'], filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }] });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  const workbook = XLSX.readFile(selected.filePaths[0]);
  const db = await connect();
  if (!db) return { ok: false, error: 'تعذر الاتصال بـ MySQL للاستيراد' };
  const confirmation = await dialog.showMessageBox({ type: 'warning', buttons: ['إلغاء', 'استيراد السجلات'], defaultId: 0, cancelId: 0, title: 'تأكيد الاستيراد', message: 'سيستورد النظام الحسابات والعملاء والعملات من الملف ويتجاوز السجلات المكررة. هل تريد المتابعة؟' });
  if (confirmation.response !== 1) return { canceled: true };
  let imported = 0;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    for (const row of XLSX.utils.sheet_to_json(workbook.Sheets['الحسابات'] || {})) { if (!row.code || !row.name_ar) continue; await connection.execute('INSERT IGNORE INTO accounts (code, name_ar, account_type, active) VALUES (?, ?, ?, TRUE)', [String(row.code), String(row.name_ar), row.account_type || 'asset']); imported += 1; }
    for (const row of XLSX.utils.sheet_to_json(workbook.Sheets['العملاء'] || {})) { if (!row.full_name) continue; const no = row.customer_no || `IMP-C-${Date.now()}-${imported}`; await connection.execute('INSERT IGNORE INTO customers (customer_no, full_name, phone, address_ar, customer_type, active) VALUES (?, ?, ?, ?, ?, TRUE)', [String(no), String(row.full_name), row.phone || null, row.address_ar || null, row.customer_type || 'customer']); imported += 1; }
    for (const row of XLSX.utils.sheet_to_json(workbook.Sheets['العملات'] || {})) { if (!row.code || !row.name_ar) continue; await connection.execute('INSERT IGNORE INTO currencies (code, name_ar, is_base, buy_rate, sell_rate, transfer_rate, active) VALUES (?, ?, FALSE, ?, ?, ?, TRUE)', [String(row.code), String(row.name_ar), Number(row.buy_rate || 1), Number(row.sell_rate || 1), Number(row.transfer_rate || row.buy_rate || 1)]); imported += 1; }
    await connection.commit();
    const archivedPath=archiveImportedFile(selected.filePaths[0],new Date());
    recordImportExportActivity('import',`تم استيراد ${imported} سجل من Excel`,archivedPath);
    return { ok: true, imported, archivedPath };
  } catch (error) { await connection.rollback(); return { ok: false, error: error.message || 'تعذر استيراد ملف Excel' }; } finally { connection.release(); }
});

ipcMain.handle('connect-google-drive', async () => {
  const session = await execute('getSession');
  if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
  const selected = await dialog.showOpenDialog({ title: 'اختيار ملف تفويض Google Drive', properties: ['openFile'], filters: [{ name: 'Google OAuth JSON', extensions: ['json'] }] });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  let config;
  try { config = JSON.parse(fs.readFileSync(selected.filePaths[0], 'utf8')).installed; } catch { return { ok: false, error: 'ملف تفويض Google غير صالح' }; }
  if (!config?.client_id || !config?.client_secret) return { ok: false, error: 'اختر ملف client_secret الخاص بتطبيق سطح المكتب' };
  fs.copyFileSync(selected.filePaths[0], driveClientPath);
  try { if (fs.existsSync(driveTokenPath)) fs.unlinkSync(driveTokenPath); } catch { /* token cleanup */ }
  return await new Promise((resolve) => {
    const server = require('http').createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (!url.searchParams.get('code')) { response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<!doctype html><html dir="rtl"><meta charset="utf-8"><body><h2>لم يكتمل التفويض. يمكنك إغلاق هذه الصفحة.</h2></body></html>'); return; }
      try {
        const oauth = new google.auth.OAuth2(config.client_id, config.client_secret, `http://127.0.0.1:${server.address().port}`);
        const { tokens } = await oauth.getToken(url.searchParams.get('code'));
        fs.writeFileSync(driveTokenPath, JSON.stringify(tokens, null, 2), 'utf8');
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html dir="rtl"><meta charset="utf-8"><title>تم الربط</title><body style="font-family:Tahoma,Arial,sans-serif;padding:48px;background:#f4f7fb;color:#16324f"><h2>تم ربط Google Drive بنجاح.</h2><p>يمكنك إغلاق هذه الصفحة والعودة إلى نظام الصراف.</p></body></html>');
        server.close();
        resolve({ ok: true });
      } catch (error) { response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<!doctype html><html dir="rtl"><meta charset="utf-8"><body><h2>تعذر إكمال التفويض. ارجع إلى التطبيق وحاول مرة أخرى.</h2></body></html>'); server.close(); resolve({ ok: false, error: error.message || 'تعذر ربط Google Drive' }); }
    });
    server.listen(0, '127.0.0.1', () => {
      const redirectUri = `http://127.0.0.1:${server.address().port}`;
      const oauth = new google.auth.OAuth2(config.client_id, config.client_secret, redirectUri);
      shell.openExternal(oauth.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: sheetsDesignerScopes }));
    });
  });
});

ipcMain.handle('create-sheets-designer-template', async () => {
  try {
    await requireSheetsDesignerAdmin();
    return { ok:true, template:await createSheetsDesignerTemplate() };
  } catch (error) { return { ok:false, error:error.message || 'تعذر إنشاء قالب مصمم Google Sheets' }; }
});

ipcMain.handle('upgrade-sheets-designer-template', async (_event, rawSpreadsheetId) => {
  try {
    await requireSheetsDesignerAdmin();
    return { ok:true, template:await upgradeSheetsDesignerTemplate(rawSpreadsheetId) };
  } catch (error) { return { ok:false, error:error.message || 'تعذر تجديد النموذج العربي المرتبط' }; }
});

ipcMain.handle('read-sheets-designer', async (_event, rawSpreadsheetId) => {
  try {
    await requireSheetsDesignerAdmin();
    const spreadsheetId=spreadsheetIdFromInput(rawSpreadsheetId);
    const sheets=await sheetsDesignerClient();
    const spreadsheet=await sheets.spreadsheets.get({ spreadsheetId, includeGridData:true });
    let design=readVisualSheetsDesignerDesign(spreadsheet.data,sheetsDesignerOperations,sheetsDesignerExternalSurfaces);
    if (!design) { const result=await sheets.spreadsheets.values.get({ spreadsheetId, range:`${sheetsTabName('CONTROLS')}!A1:H2000`, majorDimension:'ROWS' }); design=safeSheetsDesignerDesign(result.data.values || []); }
    return { ok:true, spreadsheet:{ id:spreadsheet.data.spreadsheetId, url:spreadsheet.data.spreadsheetUrl, title:spreadsheet.data.properties?.title || 'Google Sheets' }, design };
  } catch (error) { return { ok:false, error:error.message || 'تعذر قراءة تصميم Google Sheets' }; }
});

ipcMain.handle('open-sheets-designer', async (_event, rawUrl) => {
  try {
    await requireSheetsDesignerAdmin();
    const spreadsheetId=spreadsheetIdFromInput(rawUrl);
    await shell.openExternal(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
    return { ok:true };
  } catch (error) { return { ok:false, error:error.message || 'تعذر فتح ملف Google Sheets' }; }
});
ipcMain.handle('sync-google-sheets-data', async (_event, input = {}) => { try { return { ok:true, data:await syncSarafaDataToSheets(input) }; } catch (error) { return { ok:false, error:error.message || 'تعذرت مزامنة البيانات إلى Google Sheets' }; } });

ipcMain.handle('backup-google-drive', async () => {
  const session = await execute('getSession');
  if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
  try {
    const auth = await getDriveAuth(); const drive = google.drive({ version: 'v3', auth }); const folderId = await getSarafaDriveFolder(drive);
    const payload = await buildBackupPayload(); const filename = `sarafa-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const file = await drive.files.create({ requestBody: { name: filename, parents: [folderId], mimeType: 'application/json' }, media: { mimeType: 'application/json', body: JSON.stringify(payload) }, fields: 'id,name,createdTime' });
    return { ok: true, name: file.data.name };
  } catch (error) { return { ok: false, error: error.message || 'تعذر إنشاء نسخة Google Drive' }; }
});

ipcMain.handle('list-google-backups', async () => {
  const session = await execute('getSession');
  if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
  try { const auth = await getDriveAuth(); const drive = google.drive({ version: 'v3', auth }); const folderId = await getSarafaDriveFolder(drive); const list = await drive.files.list({ q: `'${folderId}' in parents and trashed=false`, orderBy: 'createdTime desc', fields: 'files(id,name,createdTime,size)' }); return { ok: true, files: list.data.files || [] }; } catch (error) { return { ok: false, error: error.message || 'تعذر قراءة نسخ Google Drive' }; }
});

ipcMain.handle('restore-google-drive', async (_event, fileId) => {
  const session = await execute('getSession');
  if (!session) return { ok: false, error: 'يرجى تسجيل الدخول أولًا' };
  const confirmation = await dialog.showMessageBox({ type: 'warning', buttons: ['إلغاء', 'استعادة الآن'], defaultId: 0, cancelId: 0, title: 'تأكيد الاستعادة من Google Drive', message: 'سيتم استبدال بيانات النظام بالنسخة المختارة. هل تريد المتابعة؟' });
  if (confirmation.response !== 1) return { canceled: true };
  try { const auth = await getDriveAuth(); const drive = google.drive({ version: 'v3', auth }); const result = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' }); const backup = JSON.parse(Buffer.from(result.data).toString('utf8')); await restoreBackupPayload(backup); return { ok: true }; } catch (error) { return { ok: false, error: error.message || 'تعذرت الاستعادة من Google Drive' }; }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  ensureData();
  markUpdateHealthOnLaunch();
  if (scheduledBackupMode) {
    runAutomaticBackup({ reason:'windows-daily-task', uploadGoogle:true }).catch((error) => writeBackupState({ ok:false, reason:'windows-daily-task', error:error.message || 'تعذر تشغيل النسخة اليومية' })).finally(() => app.quit());
    return;
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  powerMonitor.on('shutdown', (event) => {
    if (backupIsFresh()) return;
    event.preventDefault();
    if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBoxSync(mainWindow,{ type:'warning', title:'تنبيه نسخة احتياطية', message:'سيُنشئ النظام نسخة محلية سريعة قبل إيقاف Windows أو إعادة تشغيله.', buttons:['متابعة'], defaultId:0 });
    runAutomaticBackup({ reason:'windows-shutdown', uploadGoogle:false }).catch((error) => writeBackupState({ ok:false, reason:'windows-shutdown', error:error.message || 'تعذر إنشاء نسخة عند الإيقاف' })).finally(() => { allowMainWindowClose=true; app.quit(); });
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
