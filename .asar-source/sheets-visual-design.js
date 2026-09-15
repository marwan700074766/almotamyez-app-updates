'use strict';

const CONTROL_HEADERS = ['Scope', 'Target', 'ElementType', 'ElementKey', 'Property', 'Value', 'Order', 'Notes'];
const CONTROL_SHEET = 'CONTROLS';
const INSTRUCTIONS_SHEET = 'INSTRUCTIONS';
const CHANGELOG_SHEET = 'CHANGELOG';

function cleanText(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function escapeSheetName(value) {
  return String(value || '').replace(/'/g, "''");
}

function spreadsheetUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit`;
}

function instructionsRows() {
  return [
    ['مصمم Google Sheets — نظام الصراف'],
    ['طريقة الاستخدام', 'عدّل القيم داخل ورقة CONTROLS فقط، ثم اختر تحديث من Sheets داخل النظام، وافحص المعاينة قبل الاعتماد.'],
    ['النطاق الآمن', 'تُقبل إعدادات المظهر والترتيب والأحجام والعناوين فقط. لا توجد خلية تعدّل MySQL أو الأرصدة أو القيود.'],
    ['الحماية', 'لا يمكن إخفاء النوافذ الأساسية أو حقول الحفظ والترحيل والمبلغ والصندوق والحساب والتاريخ المحاسبية.'],
    ['القيم', 'الألوان بصيغة #RRGGBB، والإظهار TRUE أو FALSE، والعروض والأحجام ضمن الحدود التي يطبقها النظام.'],
    ['الاستعادة', 'احفظ نسخة قبل التحديث. يمكن استخدام سجل CHANGELOG للمراجعة والرجوع إلى إعداد سابق.'],
  ];
}

function controlRows(operations = {}, externalSurfaces = []) {
  const rows = [CONTROL_HEADERS];
  const push = (scope, target, type, key, property, value, order, notes) => {
    rows.push([scope, target, type, key, property, value ?? '', order ?? '', notes ?? '']);
  };
  for (const target of externalSurfaces) {
    for (const property of ['windowBg', 'textColor', 'accent']) {
      push('SURFACE', target, 'window', 'surface', property, property === 'windowBg' ? '#eef3f8' : property === 'textColor' ? '#173651' : '#356e9f', '', 'مظهر النافذة الخارجية');
    }
    for (const property of ['headerColor', 'rowColor', 'rowHeight']) {
      push('SURFACE', target, 'table', 'all', property, property === 'headerColor' ? '#b9cbe8' : property === 'rowColor' ? '#fff9f9' : '29', '', 'مظهر جدول النافذة');
    }
  }
  for (const [target, spec] of Object.entries(operations || {})) {
    const properties = [
      ['width', '1060'], ['height', '740'], ['formColumns', '3'], ['contentWidth', '100'],
      ['formPosition', 'top'], ['tablePosition', 'top'], ['actionPosition', 'top'],
      ['windowBg', '#eef3f8'], ['formBg', '#ffffff'], ['tableBg', '#ffffff'],
      ['accent', '#356e9f'], ['textColor', '#173651'], ['formFontSize', '13'],
      ['tableFontSize', '13'], ['buttonColor', '#356e9f'], ['buttonRadius', '5'],
    ];
    for (const [property, value] of properties) push('OPERATION', target, 'window', 'window', property, value, '', 'خصائص نافذة العملية');
    ['rowHeight', 'tableFontSize', 'headerColor', 'rowColor', 'borderColor'].forEach((property) => {
      const value = property === 'rowHeight' ? '29' : property === 'tableFontSize' ? '10' : property === 'headerColor' ? '#b9cbe8' : property === 'rowColor' ? '#fff9f9' : '#bb4654';
      push('OPERATION', target, 'table', 'operations', property, value, '', 'خصائص جدول العملية');
    });
    (spec.fields || []).forEach((key, index) => push('OPERATION', target, 'field', key, 'visible', 'TRUE', String(index + 1), 'تغيير الاسم عبر Property=label؛ الحقول المحاسبية محمية.'));
    (spec.columns || []).forEach((key, index) => push('OPERATION', target, 'column', key, 'width', '', String(index + 1), 'عرض العمود بالبكسل.'));
  }
  return rows;
}

async function getSheetMetadata(sheets, spreadsheetId) {
  const response = await sheets.spreadsheets.get({ spreadsheetId, fields: 'spreadsheetId,spreadsheetUrl,properties.title,sheets.properties' });
  return response.data || {};
}

async function ensureSheets(sheets, spreadsheetId, names) {
  const metadata = await getSheetMetadata(sheets, spreadsheetId);
  const existing = new Set((metadata.sheets || []).map((item) => item.properties?.title).filter(Boolean));
  const missing = names.filter((name) => !existing.has(name));
  if (missing.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: missing.map((title) => ({ addSheet: { properties: { title } } })) } });
  }
  return metadata;
}

async function writeValues(sheets, spreadsheetId, sheetName, values) {
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `'${escapeSheetName(sheetName)}'!A:ZZ` });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${escapeSheetName(sheetName)}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values },
  });
}

async function createVisualSheetsDesignerTemplate({ sheets, title, operations, externalSurfaces }) {
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: cleanText(title || 'Sarafa Visual Designer', 120) },
      sheets: [{ properties: { title: INSTRUCTIONS_SHEET } }, { properties: { title: CONTROL_SHEET } }, { properties: { title: CHANGELOG_SHEET } }],
    },
  });
  const id = created.data.spreadsheetId;
  await writeValues(sheets, id, INSTRUCTIONS_SHEET, instructionsRows());
  await writeValues(sheets, id, CONTROL_SHEET, controlRows(operations, externalSurfaces));
  await writeValues(sheets, id, CHANGELOG_SHEET, [['وقت التحديث', 'الإجراء', 'الملاحظات'], [new Date().toISOString(), 'إنشاء قالب', 'قالب آمن قابل للمعاينة والاستعادة']]);
  return { id, spreadsheetId: id, url: created.data.spreadsheetUrl || spreadsheetUrl(id), spreadsheetUrl: created.data.spreadsheetUrl || spreadsheetUrl(id), title: created.data.properties?.title || title, controlSheet: CONTROL_SHEET };
}

async function upgradeVisualSheetsDesignerTemplate({ sheets, spreadsheetId, operations, externalSurfaces }) {
  await ensureSheets(sheets, spreadsheetId, [INSTRUCTIONS_SHEET, CONTROL_SHEET, CHANGELOG_SHEET]);
  await writeValues(sheets, spreadsheetId, INSTRUCTIONS_SHEET, instructionsRows());
  await writeValues(sheets, spreadsheetId, CONTROL_SHEET, controlRows(operations, externalSurfaces));
  await writeValues(sheets, spreadsheetId, CHANGELOG_SHEET, [['وقت التحديث', 'الإجراء', 'الملاحظات'], [new Date().toISOString(), 'تحديث القالب', 'تمت إضافة الحقول الجديدة دون المساس ببيانات MySQL']]);
  const metadata = await getSheetMetadata(sheets, spreadsheetId);
  return { id: spreadsheetId, spreadsheetId, url: metadata.spreadsheetUrl || spreadsheetUrl(spreadsheetId), spreadsheetUrl: metadata.spreadsheetUrl || spreadsheetUrl(spreadsheetId), title: metadata.properties?.title || 'Google Sheets', controlSheet: CONTROL_SHEET };
}

function cellValue(cell) {
  if (!cell) return '';
  if (cell.formattedValue !== undefined) return cell.formattedValue;
  const value = cell.effectiveValue || cell.userEnteredValue || {};
  return value.stringValue ?? value.numberValue ?? value.boolValue ?? '';
}

function rowsFromSheet(sheet) {
  const data = sheet?.data || [];
  const rows = [];
  for (const block of data) {
    for (const row of block.rowData || []) rows.push((row.values || []).map(cellValue));
  }
  return rows;
}

function readVisualSheetsDesignerDesign(spreadsheet, operations = {}, externalSurfaces = []) {
  const controlSheet = (spreadsheet?.sheets || []).find((sheet) => sheet.properties?.title === CONTROL_SHEET);
  const rows = rowsFromSheet(controlSheet);
  if (!rows.length) return null;
  const header = rows[0].map((value) => cleanText(value, 40).toLowerCase());
  const index = Object.fromEntries(['scope', 'target', 'elementtype', 'elementkey', 'property', 'value', 'order'].map((key) => [key, header.indexOf(key)]));
  if (Object.values(index).some((value) => value < 0)) return null;
  const design = { ui: {}, appearance: {}, surfaces: {}, windowTargets: {}, tableTargets: {}, warnings: [], importedRows: 0 };
  const external = new Set(externalSurfaces);
  const operationNames = new Set(Object.keys(operations));
  const color = (value) => /^#[0-9a-f]{6}$/i.test(cleanText(value, 20)) ? cleanText(value, 20) : null;
  const number = (value, min, max) => { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null; };
  const bool = (value) => ['true', '1', 'yes', 'نعم', 'نعم'].includes(cleanText(value, 20).toLowerCase()) ? true : ['false', '0', 'no', 'لا'].includes(cleanText(value, 20).toLowerCase()) ? false : null;
  const order = number(rows[0][index.order], 1, 9999);
  void order;
  rows.slice(1).forEach((row, rowIndex) => {
    const scope = cleanText(row[index.scope], 30).toUpperCase();
    const target = cleanText(row[index.target], 100);
    const type = cleanText(row[index.elementtype], 30).toLowerCase();
    const key = cleanText(row[index.elementkey], 100);
    const property = cleanText(row[index.property], 60);
    const value = row[index.value];
    if (!target || !property) return;
    const validTarget = scope === 'SURFACE' ? external.has(target) : scope === 'OPERATION' && operationNames.has(target);
    if (!validTarget) { design.warnings.push(`تم تجاهل صف غير مسموح في الصف ${rowIndex + 2}`); return; }
    const targetBag = scope === 'SURFACE' ? design.surfaces : design.windowTargets;
    targetBag[target] = targetBag[target] || {};
    if (type === 'window' || type === 'surface') {
      const allowed = ['windowBg', 'formBg', 'tableBg', 'accent', 'textColor', 'buttonColor'];
      const parsed = allowed.includes(property) ? color(value) : ['width', 'height'].includes(property) ? number(value, 520, 1800) : ['formColumns'].includes(property) ? number(value, 1, 4) : ['contentWidth'].includes(property) ? number(value, 70, 100) : ['buttonRadius'].includes(property) ? number(value, 0, 18) : ['formFontSize', 'tableFontSize'].includes(property) ? number(value, 8, 24) : ['formPosition', 'tablePosition', 'actionPosition'].includes(property) ? ['top', 'bottom'].includes(cleanText(value, 20)) ? cleanText(value, 20) : null : property === 'title' ? cleanText(value, 100) : null;
      if (parsed !== null) targetBag[target][property] = parsed;
    } else if (type === 'field') {
      targetBag[target].fields = targetBag[target].fields || {};
      const parsed = property === 'visible' ? bool(value) : property === 'order' ? number(row[index.order], 1, 9999) : property === 'label' ? cleanText(value, 100) : null;
      if (parsed !== null) targetBag[target].fields[key] = { ...(targetBag[target].fields[key] || {}), [property]: parsed };
    } else if (type === 'column') {
      design.tableTargets[target] = design.tableTargets[target] || { columns: {} };
      const parsed = property === 'visible' ? bool(value) : property === 'order' ? number(row[index.order], 1, 9999) : property === 'width' ? number(value, 70, 500) : property === 'label' ? cleanText(value, 100) : null;
      if (parsed !== null) design.tableTargets[target].columns[key] = { ...(design.tableTargets[target].columns[key] || {}), [property]: parsed };
    }
    design.importedRows += 1;
  });
  return design;
}

module.exports = { createVisualSheetsDesignerTemplate, upgradeVisualSheetsDesignerTemplate, readVisualSheetsDesignerDesign };
