const operationChromeMap = {
  'voucher-payment': { title:'سند صرف', tone:'payment', save:'saveVoucher()', fresh:"newVoucherEntry('payment')", refresh:"navigate('voucher-payment')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'voucher-receipt': { title:'سند قبض', tone:'receipt', save:'saveVoucher()', fresh:"newVoucherEntry('receipt')", refresh:"navigate('voucher-receipt')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'transfers-incoming': { title:'حوالة واردة', tone:'transfer-incoming', save:'saveTransfer()', fresh:"navigate('transfers-incoming')", refresh:"navigate('transfers-incoming')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'new-transfer-incoming': { title:'حوالة واردة', tone:'transfer-incoming', save:'saveTransfer()', fresh:"navigate('new-transfer-incoming')", refresh:"navigate('new-transfer-incoming')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'transfers-outgoing': { title:'حوالة صادرة', tone:'transfer-outgoing', save:'saveTransfer()', fresh:"navigate('transfers-outgoing')", refresh:"navigate('transfers-outgoing')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'new-transfer-outgoing': { title:'حوالة صادرة', tone:'transfer-outgoing', save:'saveTransfer()', fresh:"navigate('new-transfer-outgoing')", refresh:"navigate('new-transfer-outgoing')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'exchange-buy': { title:'شراء عملات', tone:'exchange-buy', save:'saveExchange()', fresh:"navigate('exchange-buy')", refresh:"navigate('exchange-buy')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'new-exchange-buy': { title:'شراء عملات', tone:'exchange-buy', save:'saveExchange()', fresh:"navigate('new-exchange-buy')", refresh:"navigate('new-exchange-buy')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'exchange-sell': { title:'بيع عملات', tone:'exchange-sell', save:'saveExchange()', fresh:"navigate('exchange-sell')", refresh:"navigate('exchange-sell')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'new-exchange-sell': { title:'بيع عملات', tone:'exchange-sell', save:'saveExchange()', fresh:"navigate('new-exchange-sell')", refresh:"navigate('new-exchange-sell')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'simple-entries': { title:'قيد بسيط', tone:'simple', save:'saveSimpleEntry()', fresh:"navigate('simple-entries')", refresh:"navigate('simple-entries')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'new-simple-entry': { title:'قيد بسيط', tone:'simple', save:'saveSimpleEntry()', fresh:"navigate('new-simple-entry')", refresh:"navigate('new-simple-entry')", query:"document.querySelector('.operation-table-tools input')?.focus()" },
  'account-statement': { title:'كشف حساب', tone:'statement', save:'loadStatement()', fresh:"document.getElementById('statementAccount')?.focus()", refresh:'loadStatement()', query:"document.querySelector('.operation-table-tools input')?.focus()", saveLabel:'عرض الكشف' }
};

function operationChromeToolbar(config) {
  return `<div class="operation-command-bar form-actions" data-operation-toolbar="true"><button class="primary-btn" onclick="${config.save}">${config.saveLabel || 'إضافة وحفظ'}</button><button class="secondary-btn" onclick="${config.fresh}">جديد</button><button class="secondary-btn" onclick="${config.query}">بحث</button><button class="secondary-btn" onclick="${config.refresh}">تحديث</button><button class="secondary-btn" onclick="previewPrint()">طباعة ومعاينة</button><button class="secondary-btn" onclick="savePdfFile()">PDF</button><button class="exit-btn" onclick="closeWorkWindow()">خروج</button></div>`;
}

function addOperationTableTools(root) {
  root.querySelectorAll('.table-wrap').forEach((tableWrap) => {
    if (tableWrap.parentElement?.querySelector(':scope > .operation-table-tools')) return;
    const tools=document.createElement('div');
    tools.className='operation-table-tools';
    tools.innerHTML='<input class="search" aria-label="بحث داخل جدول العمليات" placeholder="بحث داخل العمليات…" oninput="filterRows(this)"><span>اسحب شريط التمرير لعرض كل الأعمدة</span>';
    tableWrap.before(tools);
  });
}

function clearOperationHints(root) {
  root.querySelectorAll('.field input[placeholder],.field textarea[placeholder]').forEach((field) => field.removeAttribute('placeholder'));
  root.querySelectorAll('.field select').forEach((select) => {
    const first=select.options[0];
    if (first && !first.value && /اختر من القائمة/i.test(first.textContent || '')) first.textContent='';
  });
}

function addSmartSelectArrows(root) {
  const design=(settings.uiDesigner || {}); const scope=design.selectScope || 'system';
  root.querySelectorAll('.smart-select-wrap').forEach((wrap) => { const select=wrap.querySelector('select'); const tableOnly=scope === 'tables'; const allowed=!tableOnly || Boolean(select?.closest('.table-wrap,.toolbar,.daily-operations-panel,.operation-table-tools')); if (!allowed && select) { wrap.replaceWith(select); } });
  root.querySelectorAll('select').forEach((select) => {
    if (select.closest('.ui-designer-shell')) return;
    if (scope === 'tables' && !select.closest('.table-wrap,.toolbar,.daily-operations-panel,.operation-table-tools')) return;
    if (select.parentElement?.classList.contains('smart-select-wrap')) return;
    const wrap=document.createElement('span');
    wrap.className='smart-select-wrap';
    select.parentNode.insertBefore(wrap,select);
    wrap.append(select);
    const arrow=document.createElement('button');
    arrow.type='button';
    arrow.className='smart-select-arrow';
    arrow.setAttribute('aria-label','فتح قائمة الاختيار');
    arrow.innerHTML=(design.selectStyle || 'smart') === 'reference' ? '▼' : '⌄';
    arrow.addEventListener('click',() => { select.focus(); if (select.showPicker) select.showPicker(); else select.click(); });
    wrap.append(arrow);
  });
}

function colorizeOperationButtons(root) {
  root.querySelectorAll('button:not(.smart-select-arrow)').forEach((button) => {
    const label=(button.textContent || '').trim();
    button.classList.remove('operation-action-save','operation-action-new','operation-action-search','operation-action-refresh','operation-action-print','operation-action-pdf','operation-action-exit');
    const action=/إضافة|حفظ|عرض الكشف/.test(label) ? 'save' : /جديد/.test(label) ? 'new' : /بحث/.test(label) ? 'search' : /تحديث/.test(label) ? 'refresh' : /طباعة|معاينة/.test(label) ? 'print' : /PDF/.test(label) ? 'pdf' : /خروج|إلغاء|عودة/.test(label) ? 'exit' : '';
    if (action) button.classList.add(`operation-action-${action}`);
  });
}

function applySingleDocumentTitle(root) {
  const heads=[...root.querySelectorAll(':scope > .page-head')];
  const titleText=heads.map((head) => head.querySelector('h2')?.textContent?.trim()).find(Boolean);
  if (!titleText) return;
  const actions=[];
  heads.forEach((head) => {
    head.querySelectorAll(':scope > button,:scope > .form-actions button,:scope > div:last-child > button').forEach((button) => {
      if (!actions.includes(button)) actions.push(button);
    });
  });
  root.querySelectorAll(':scope > .system-document-title').forEach((title) => title.remove());
  root.querySelectorAll(':scope > .voucher-panel-title,:scope > .daily-operations-title').forEach((title) => title.remove());
  const bar=document.createElement('div');
  bar.className='system-document-title';
  bar.setAttribute('data-system-document-title','true');
  const right=document.createElement('div'); right.className='system-title-actions';
  actions.forEach((button) => right.append(button));
  if (!right.querySelector('.exit-btn')) right.insertAdjacentHTML('beforeend','<button class="exit-btn" type="button" onclick="closeWorkWindow()">خروج</button>');
  bar.append(document.createElement('span'),Object.assign(document.createElement('strong'),{ textContent:titleText }),right);
  heads.forEach((head) => head.remove());
  root.prepend(bar);
}

function ensureExitAction(root) {
  if (root.querySelector('.exit-btn')) return;
  const titleActions=root.querySelector('.system-title-actions');
  if (titleActions) { titleActions.insertAdjacentHTML('beforeend','<button class="exit-btn" type="button" onclick="closeWorkWindow()">خروج</button>'); return; }
  root.insertAdjacentHTML('afterbegin','<button class="exit-btn system-floating-exit" type="button" onclick="closeWorkWindow()">خروج</button>');
}

function applyOperationChrome(viewName) {
  const config=operationChromeMap[viewName];
  const root=document.getElementById('view');
  if (!root) return;
  document.body.classList.remove('compact-system-workspace');
  root.classList.remove('operation-chrome',...Array.from(root.classList).filter((name) => name.startsWith('operation-tone-')));
  root.classList.add('system-table-chrome');
  clearOperationHints(root);
  addSmartSelectArrows(root);
  colorizeOperationButtons(root);
  if (!config) { applySingleDocumentTitle(root); ensureExitAction(root); colorizeOperationButtons(root); return; }
  document.body.classList.add('compact-system-workspace');
  root.classList.add('operation-chrome',`operation-tone-${config.tone}`);
  root.querySelectorAll('.page-head').forEach((head) => head.remove());
  const panelTitles=[...root.querySelectorAll('.voucher-panel-title')];
  if (panelTitles.length) {
    panelTitles[0].textContent=config.title;
    panelTitles.slice(1).forEach((title) => title.remove());
    root.querySelectorAll('.daily-operations-title').forEach((title) => title.remove());
  } else if (!root.querySelector('.operation-title-bar')) {
    const title=document.createElement('div');
    title.className='operation-title-bar';
    title.innerHTML=`<span></span><strong>${config.title}</strong><span></span>`;
    root.prepend(title);
  }
  const voucherActions=root.querySelector('.voucher-actions');
  if (voucherActions) {
    voucherActions.classList.add('operation-command-bar','form-actions');
    if (!voucherActions.querySelector('.exit-btn')) voucherActions.insertAdjacentHTML('beforeend','<button class="exit-btn" onclick="closeWorkWindow()">خروج</button>');
  } else {
    const host=root.querySelector('.form-actions');
    if (host) host.outerHTML=operationChromeToolbar(config);
    else {
      const form=root.querySelector('.card,.quick-entry-card,.voucher-panel');
      if (form) form.insertAdjacentHTML('beforeend',operationChromeToolbar(config));
    }
  }
  ensureExitAction(root);
  addOperationTableTools(root);
  clearOperationHints(root);
  addSmartSelectArrows(root);
  colorizeOperationButtons(root);
}

window.applyOperationChrome=applyOperationChrome;
