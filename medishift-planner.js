// Passômetro - Core Logic
// Compatível com Google Apps Script API

// Configuration
// Keep the same Google Apps Script URL as the existing deployment.
const API_URL = window.__API_URL__ || '/api/patients';
const SCHEDULE_API = window.__SCHEDULE_API__ || '/api/schedule';
const FETCH_TIMEOUT_MS = 15000; // 15 seconds max per request

// State
let allPatients = [];
let filteredPatients = [];
let currentAntibiotics = [];
let printWindowRef = null;
let scheduleMonthOffset = 0;
let _isSubmitting = false;
let _searchDebounceTimer = null;

// Safe DOM helper — returns element or null without throwing
function $(id) {
    return document.getElementById(id);
}

// Fetch with timeout to prevent hanging requests
function fetchWithTimeout(url, options, timeoutMs) {
    const ms = timeoutMs || FETCH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    const opts = Object.assign({}, options, { signal: controller.signal });
    return fetch(url, opts).finally(() => clearTimeout(timer));
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
});

function initializeApp() {
    try { setupEventListeners(); } catch (e) { console.error('setupEventListeners failed:', e); }
    try { setDefaultAdmissionDate(); } catch (e) { console.error('setDefaultAdmissionDate failed:', e); }
    loadPatients();
    renderSchedule();
}

function setupEventListeners() {
    // Helper: safely add listener only when element exists
    function on(id, event, handler) {
        const el = $(id);
        if (el) el.addEventListener(event, handler);
    }

    // Header actions
    on('tabPatientsBtn', 'click', () => showPatientsTab());
    on('tabScheduleBtn', 'click', () => showScheduleTab());
    on('addPatientBtn', 'click', () => openModal());
    on('refreshBtn', 'click', () => loadPatients());
    on('printBtn', 'click', openPrintView);
    on('pdfBtn', 'click', exportPdfFromBrowser);
    on('schedulePrevBtn', 'click', () => { scheduleMonthOffset--; renderSchedule(); });
    on('scheduleNextBtn', 'click', () => { scheduleMonthOffset++; renderSchedule(); });
    on('scheduleTodayBtn', 'click', () => { scheduleMonthOffset = 0; renderSchedule(); });
    
    // Search and filters (debounced search)
    on('searchInput', 'input', () => {
        clearTimeout(_searchDebounceTimer);
        _searchDebounceTimer = setTimeout(applyFilters, 250);
    });
    on('filterPriority', 'change', applyFilters);
    on('filterAuthor', 'change', applyFilters);
    
    // Form
    on('patientForm', 'submit', handleFormSubmit);
    on('addAntibioticBtn', 'click', addAntibioticField);
    
    // Admission date change
    on('admissionDate', 'change', () => {
        const admissionDate = $('admissionDate').value;
        if (admissionDate) {
            const dih = calculateDIH(admissionDate);
            console.log(`DIH: ${dih} dias`);
        }
    });
}

function setDefaultAdmissionDate() {
    const el = $('admissionDate');
    if (el) {
        el.value = new Date().toISOString().split('T')[0];
    }
}

// API Functions
async function loadPatients() {
    showLoading(true);
    try {
        const response = await fetchWithTimeout(API_URL);
        const data = await response.json();
        
        if (data.success) {
            allPatients = data.patients || [];
            updateAuthorFilter();
            applyFilters();
        } else {
            showError('Erro ao carregar pacientes');
        }
    } catch (error) {
        console.error('Error loading patients:', error);
        if (error.name === 'AbortError') {
            showError('Tempo limite excedido ao carregar pacientes. Verifique sua conexão.');
        } else {
            showError('Erro de conexão. Verifique a URL da API.');
        }
    } finally {
        showLoading(false);
    }
}

async function savePatient(patientData, isNew = false) {
    try {
        const response = await fetchWithTimeout(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'savePatient',
                patient: patientData
            })
        });

        const data = await response.json();

        if (data.success) {
            showSuccess(isNew ? 'Paciente adicionado!' : 'Paciente atualizado!');
            closeModal();
            loadPatients();
        } else {
            showError('Erro ao salvar paciente');
        }
    } catch (error) {
        console.error('Error saving patient:', error);
        if (error.name === 'AbortError') {
            showError('Tempo limite excedido ao salvar. Tente novamente.');
        } else {
            showError('Erro ao salvar. Tente novamente.');
        }
    }
}

async function deletePatient(patientId) {
    if (!confirm('Tem certeza que deseja excluir este paciente?')) {
        return;
    }
    
    try {
        const response = await fetchWithTimeout(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'deletePatient',
                id: patientId
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showSuccess('Paciente excluído!');
            loadPatients();
        } else {
            showError('Erro ao excluir paciente');
        }
    } catch (error) {
        console.error('Error deleting patient:', error);
        if (error.name === 'AbortError') {
            showError('Tempo limite excedido ao excluir. Tente novamente.');
        } else {
            showError('Erro ao excluir. Tente novamente.');
        }
    }
}

// Filter Functions
function applyFilters() {
    const searchEl = $('searchInput');
    const priorityEl = $('filterPriority');
    const authorEl = $('filterAuthor');
    const searchTerm = (searchEl ? searchEl.value : '').toLowerCase();
    const priorityFilter = priorityEl ? priorityEl.value : '';
    const authorFilter = authorEl ? authorEl.value : '';
    
    filteredPatients = allPatients.filter(patient => {
        // Search filter
        const matchesSearch = !searchTerm || 
            patient.name?.toLowerCase().includes(searchTerm) ||
            patient.bedNumber?.toLowerCase().includes(searchTerm) ||
            patient.diagnosis?.toLowerCase().includes(searchTerm) ||
            patient.currentCondition?.toLowerCase().includes(searchTerm) ||
            patient.pendingActions?.toLowerCase().includes(searchTerm) ||
            patient.nextSteps?.toLowerCase().includes(searchTerm);
        
        // Priority filter
        const matchesPriority = !priorityFilter || patient.priority === priorityFilter;
        
        // Author filter
        const matchesAuthor = !authorFilter || patient.author === authorFilter;
        
        return matchesSearch && matchesPriority && matchesAuthor;
    });
    
    renderPatients();
}

function updateAuthorFilter() {
    const authors = [...new Set(allPatients.map(p => p.author).filter(Boolean))];
    const filterSelect = $('filterAuthor');
    if (!filterSelect) return;
    
    // Keep current selection
    const currentValue = filterSelect.value;
    
    // Clear and rebuild
    filterSelect.innerHTML = '<option value="">Todos Autores</option>';
    authors.sort().forEach(author => {
        const option = document.createElement('option');
        option.value = author;
        option.textContent = author;
        filterSelect.appendChild(option);
    });
    
    // Restore selection if still valid
    if (authors.includes(currentValue)) {
        filterSelect.value = currentValue;
    }
}

// Render Functions
function showPatientsTab() {
    const patientsView = $('patientsView'); if (patientsView) patientsView.style.display = 'block';
    const scheduleView = $('scheduleView'); if (scheduleView) scheduleView.style.display = 'none';
    const patientsBtn = $('tabPatientsBtn'); if (patientsBtn) patientsBtn.classList.add('active');
    const scheduleBtn = $('tabScheduleBtn'); if (scheduleBtn) scheduleBtn.classList.remove('active');
}

function showScheduleTab() {
    const patientsView = $('patientsView'); if (patientsView) patientsView.style.display = 'none';
    const scheduleView = $('scheduleView'); if (scheduleView) scheduleView.style.display = 'block';
    const scheduleBtn = $('tabScheduleBtn'); if (scheduleBtn) scheduleBtn.classList.add('active');
    const patientsBtn = $('tabPatientsBtn'); if (patientsBtn) patientsBtn.classList.remove('active');
    renderSchedule();
}

function renderPatients() {
    const grid = $('patientsGrid');
    const emptyState = $('emptyState');
    if (!grid) return;
    updatePrintView();
    
    if (filteredPatients.length === 0) {
        grid.innerHTML = '';
        if (emptyState) emptyState.style.display = 'flex';
        return;
    }
    
    if (emptyState) emptyState.style.display = 'none';
    
    // Sort by priority (Alta > Média > Baixa)
    const priorityOrder = { 'Alta': 1, 'Média': 2, 'Baixa': 3 };
    const sorted = [...filteredPatients].sort((a, b) => {
        return (priorityOrder[a.priority] || 999) - (priorityOrder[b.priority] || 999);
    });
    
    grid.innerHTML = sorted.map(patient => createPatientCard(patient)).join('');
}

function createPatientCard(patient) {
    const dih = calculateDIH(patient.admissionDate);
    const antibioticsHtml = renderAntibiotics(patient.antibiotics);
    const priorityClass = getPriorityClass(patient.priority);
    const lastUpdated = formatDateTime(patient.lastModified || patient.createdAt);
    
    return `
        <div class="patient-card" data-id="${patient.id}">
            <div class="card-header">
                <div class="card-title">
                    <h3>${escapeHtml(patient.name)}</h3>
                    <span class="bed-badge">${escapeHtml(patient.bedNumber)}</span>
                    ${dih !== null ? `<span class="dih-badge">DIH: ${dih}d</span>` : ''}
                </div>
                <div class="card-actions">
                    <span class="priority-badge priority-${priorityClass}">${patient.priority || 'Baixa'}</span>
                    <button class="btn-icon" onclick="editPatient('${patient.id}')" title="Editar">
                        <i class="fas fa-edit"></i>
                    </button>
                    <button class="btn-icon" onclick="deletePatient('${patient.id}')" title="Excluir">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
            
            ${patient.shiftRole || patient.shiftDetails ? `
                <div class="card-section">
                    <strong><i class="fas fa-user-clock"></i> Turnos:</strong>
                    <p>${escapeHtml(patient.shiftRole || '')}${patient.shiftRole && patient.shiftDetails ? ' — ' : ''}${escapeHtml(patient.shiftDetails || '')}</p>
                </div>
            ` : ''}

            ${patient.diagnosis ? `
                <div class="card-section">
                    <strong><i class="fas fa-stethoscope"></i> Diagnóstico:</strong>
                    <p>${escapeHtml(patient.diagnosis)}</p>
                </div>
            ` : ''}
            
            ${antibioticsHtml ? `
                <div class="card-section">
                    <strong><i class="fas fa-pills"></i> Antibioticoterapia:</strong>
                    ${antibioticsHtml}
                </div>
            ` : ''}
            
            ${patient.currentCondition ? `
                <div class="card-section">
                    <strong><i class="fas fa-heartbeat"></i> Condição Atual:</strong>
                    <p>${escapeHtml(patient.currentCondition)}</p>
                </div>
            ` : ''}
            
            ${patient.pendingActions ? `
                <div class="card-section">
                    <strong><i class="fas fa-tasks"></i> Pendências:</strong>
                    <p>${escapeHtml(patient.pendingActions)}</p>
                </div>
            ` : ''}
            
            ${patient.nextSteps ? `
                <div class="card-section">
                    <strong><i class="fas fa-route"></i> Próximos Passos:</strong>
                    <p>${escapeHtml(patient.nextSteps)}</p>
                </div>
            ` : ''}
            
            <div class="card-footer">
                <small>
                    <i class="fas fa-user"></i> ${escapeHtml(patient.author || 'Desconhecido')}
                    <i class="fas fa-clock"></i> ${lastUpdated}
                </small>
            </div>
        </div>
    `;
}

function normalizeAntibiotics(antibiotics) {
    if (!antibiotics) return [];
    if (Array.isArray(antibiotics)) return antibiotics.filter(Boolean).map(ab => {
        if (typeof ab === 'string') return { name: ab, startDate: '' };
        return { name: ab.name || ab.medicine || '', startDate: ab.startDate || ab.date || '' };
    });
    if (typeof antibiotics === 'string') {
        try {
            const parsed = JSON.parse(antibiotics);
            if (Array.isArray(parsed)) return normalizeAntibiotics(parsed);
        } catch (_) {
            return antibiotics.split(/\n|,|;/).map(s => s.trim()).filter(Boolean).map(name => ({ name, startDate: '' }));
        }
    }
    return [];
}

function renderAntibiotics(antibiotics) {
    const list = normalizeAntibiotics(antibiotics);
    if (!list.length) return '';
    
    return '<ul class="antibiotics-list">' + 
        list.map(ab => {
            const days = calculateAntibioticDays(ab.startDate);
            return `<li>${escapeHtml(ab.name)} ${days !== null ? `<span class="antibiotic-days">D${days}</span>` : ''}</li>`;
        }).join('') + 
        '</ul>';
}

// Modal Functions
function openModal(patientId = null) {
    const modal = $('patientModal');
    const form = $('patientForm');
    if (!modal || !form) return;
    
    form.reset();
    currentAntibiotics = [];
    
    if (patientId) {
        const patient = allPatients.find(p => p.id === patientId);
        if (patient) {
            const title = $('modalTitle');
            if (title) title.textContent = 'Editar Paciente';
            fillFormWithPatient(patient);
        }
    } else {
        const title = $('modalTitle');
        if (title) title.textContent = 'Adicionar Paciente';
        setDefaultAdmissionDate();
    }
    
    modal.style.display = 'flex';
}

function closeModal() {
    const modal = $('patientModal');
    if (modal) modal.style.display = 'none';
    const form = $('patientForm');
    if (form) form.reset();
    currentAntibiotics = [];
    renderAntibioticsEditor();
}

function fillFormWithPatient(patient) {
    function setVal(id, value) { const el = $(id); if (el) el.value = value; }
    setVal('patientId', patient.id);
    setVal('patientName', patient.name || '');
    setVal('bedNumber', patient.bedNumber || '');
    setVal('admissionDate', patient.admissionDate || '');
    setVal('priority', patient.priority || 'Baixa');
    setVal('diagnosis', patient.diagnosis || '');
    setVal('currentCondition', patient.currentCondition || '');
    setVal('pendingActions', patient.pendingActions || '');
    setVal('nextSteps', patient.nextSteps || '');
    setVal('shiftRole', patient.shiftRole || '');
    setVal('shiftDetails', patient.shiftDetails || '');
    setVal('author', patient.author || '');
    
    currentAntibiotics = normalizeAntibiotics(patient.antibiotics);
    renderAntibioticsEditor();
}

function editPatient(patientId) {
    openModal(patientId);
}

async function handleFormSubmit(e) {
    e.preventDefault();

    // Prevent double-submit
    if (_isSubmitting) return;
    _isSubmitting = true;

    try {
        const existingId = ($('patientId') || {}).value || '';
        const isNew = !existingId;

        const nowISO = new Date().toISOString();
        function fieldVal(id) { const el = $(id); return el ? el.value.trim() : ''; }
        const patientData = {
            id: existingId || generateId(),
            name: fieldVal('patientName'),
            bedNumber: fieldVal('bedNumber'),
            admissionDate: ($('admissionDate') || {}).value || '',
            priority: ($('priority') || {}).value || 'Baixa',
            diagnosis: fieldVal('diagnosis'),
            currentCondition: fieldVal('currentCondition'),
            pendingActions: fieldVal('pendingActions'),
            nextSteps: fieldVal('nextSteps'),
            shiftRole: fieldVal('shiftRole'),
            shiftDetails: fieldVal('shiftDetails'),
            author: fieldVal('author'),
            antibiotics: collectAntibiotics(),
            lastModified: nowISO
        };
        if (isNew) {
            patientData.createdAt = nowISO;
        }

        await savePatient(patientData, isNew);
    } finally {
        _isSubmitting = false;
    }
}

// Antibiotic Functions
function renderAntibioticsEditor() {
    const container = $('antibioticsList');
    if (!container) return;
    const list = currentAntibiotics.length ? currentAntibiotics : [{ name: '', startDate: '' }];
    container.innerHTML = list.map((ab, index) => `
        <div class="antibiotic-editor-row" data-index="${index}">
            <input type="text" class="antibiotic-name" placeholder="Medicamento" value="${escapeHtml(ab.name || '')}">
            <input type="date" class="antibiotic-date" value="${ab.startDate || ''}">
            <span class="antibiotic-days">${ab.startDate ? `(D${calculateAntibioticDays(ab.startDate) ?? '-'})` : ''}</span>
            <button type="button" class="btn-icon antibiotic-remove" title="Remover">
                <i class="fas fa-trash"></i>
            </button>
        </div>
    `).join('');

    container.querySelectorAll('.antibiotic-name').forEach((el, idx) => {
        el.addEventListener('input', () => {
            currentAntibiotics[idx] = currentAntibiotics[idx] || { name: '', startDate: '' };
            currentAntibiotics[idx].name = el.value;
        });
    });
    container.querySelectorAll('.antibiotic-date').forEach((el, idx) => {
        el.addEventListener('change', () => {
            currentAntibiotics[idx] = currentAntibiotics[idx] || { name: '', startDate: '' };
            currentAntibiotics[idx].startDate = el.value;
            renderAntibioticsEditor();
        });
    });
    container.querySelectorAll('.antibiotic-remove').forEach((btn, idx) => {
        btn.addEventListener('click', () => {
            currentAntibiotics.splice(idx, 1);
            renderAntibioticsEditor();
        });
    });
}

function addAntibioticField() {
    currentAntibiotics.push({ name: '', startDate: '' });
    renderAntibioticsEditor();
}

function collectAntibiotics() {
    return currentAntibiotics
        .map(ab => ({ name: (ab.name || '').trim(), startDate: ab.startDate || '' }))
        .filter(ab => ab.name || ab.startDate);
}

function updateAntibioticDays() {
    renderAntibioticsEditor();
}

// Calculation Functions
function calculateDIH(admissionDate) {
    if (!admissionDate) return null;
    
    const admission = new Date(admissionDate + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const diffTime = today - admission;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays >= 0 ? diffDays : null;
}

function calculateAntibioticDays(startDate) {
    if (!startDate) return null;
    
    const start = new Date(startDate + 'T00:00:00');
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const diffTime = today - start;
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24)) + 1; // +1 to include start day
    
    return diffDays >= 1 ? diffDays : null;
}

// Shift definitions
const SHIFT_LABELS = {
    manha:     'Diarista G1 08h-16h',
    vespertino:'Vespertino 14h-20h',
    noturno:   'Noturno 20h-08h',
    diurno:    'Diurno 08h-20h'
};
const WEEKDAY_SHIFTS = ['manha', 'vespertino', 'noturno'];
const WEEKEND_SHIFTS = ['diurno', 'noturno'];
const FIXED_MANHA = 'Janio Euler'; // Janio fixo na Diarista G1 (Seg-Sex)

// Seed data: ESCALA UTI GERAL - HOSPITAL NEUROCARDIO - ABRIL / 2026 (transcrita da foto)
const scheduleData = {
    '2026-04': {
        title: 'ESCALA UTI GERAL - HOSPITAL NEUROCARDIO - ABRIL / 2026',
        entries: {
            // Semana 1
            '01/04': { manha: 'Janio Euler', vespertino: 'Leonardo', noturno: 'Juliana Lustosa' }, // qua
            '02/04': { manha: 'Janio Euler', vespertino: 'Roberth',  noturno: 'Eronildo' },        // qui
            '03/04': { manha: 'Janio Euler', vespertino: 'Roberth',  noturno: 'Sarah' },           // sex
            '04/04': { diurno: 'Eronildo', noturno: 'Roberth' },                                   // sab
            '05/04': { diurno: 'Roberth',  noturno: 'Valter' },                                    // dom
            // Semana 2
            '06/04': { manha: 'Janio Euler', vespertino: 'Leonardo', noturno: 'Valter' },          // seg
            '07/04': { manha: 'Janio Euler', vespertino: 'Alexia',   noturno: 'Janio Euler'},           // ter
            '08/04': { manha: 'Janio Euler', vespertino: 'Leonardo', noturno: 'Valter' },          // qua
            '09/04': { manha: 'Janio Euler', vespertino: 'Roberth',  noturno: 'Whily' },           // qui
            '10/04': { manha: 'Janio Euler', vespertino: 'Leonardo', noturno: 'Leonardo' },        // sex
            '11/04': { diurno: 'Valter',   noturno: 'Valter' },                                    // sab
            '12/04': { diurno: 'Leonardo', noturno: 'Eronildo' },                                  // dom
            // Semana 3
            '13/04': { manha: 'Janio Euler', vespertino: 'Jose Ricardo', noturno: 'Janio Euler'},       // seg
            '14/04': { manha: 'Janio Euler', vespertino: 'Alexia',       noturno: 'Guilherme' },   // ter
            '15/04': { manha: 'Janio Euler', vespertino: 'Leonardo',     noturno: 'Juliana Lustosa' }, // qua
            '16/04': { manha: 'Janio Euler', vespertino: 'Roberth',      noturno: 'Eronildo' },    // qui
            '17/04': { manha: 'Janio Euler', vespertino: 'Roberth',      noturno: 'Sarah' },       // sex
            '18/04': { diurno: 'Eronildo', noturno: 'Roberth' },                                   // sab
            '19/04': { diurno: 'Roberth',  noturno: 'Valter' },                                    // dom
            // Semana 4
            '20/04': { manha: 'Janio Euler', vespertino: 'Leonardo', noturno: 'Valter' },          // seg
            '21/04': { manha: 'Janio Euler', vespertino: 'Alexia',   noturno: 'Janio Euler'},           // ter
            '22/04': { manha: 'Janio Euler', vespertino: 'Leonardo', noturno: 'Valter' },          // qua
            '23/04': { manha: 'Janio Euler', vespertino: 'Roberth',  noturno: 'Whily' },           // qui
            '24/04': { manha: 'Janio Euler', vespertino: 'Leonardo', noturno: 'Leonardo' },        // sex
            '25/04': { diurno: 'Valter',   noturno: 'Valter' },                                    // sab
            '26/04': { diurno: 'Leonardo', noturno: 'Eronildo' },                                  // dom
            // Semana 5
            '27/04': { manha: 'Janio Euler', vespertino: 'Jose Ricardo', noturno: 'Janio Euler'},       // seg
            '28/04': { manha: 'Janio Euler', vespertino: 'Alexia',       noturno: 'Guilherme' },   // ter
            '29/04': { manha: 'Janio Euler', vespertino: 'Leonardo',     noturno: 'Juliana Lustosa' }, // qua
            '30/04': { manha: 'Janio Euler', vespertino: 'Roberth',      noturno: 'Eronildo' }     // qui
        }
    }
};

function isWeekendDay(dayKey, monthKey) {
    const [d, m] = dayKey.split('/').map(n => parseInt(n, 10));
    const y = parseInt(monthKey.split('-')[0], 10);
    const dow = new Date(y, m - 1, d).getDay();
    return dow === 0 || dow === 6;
}

function shiftCodesForDay(dayKey, monthKey) {
    return isWeekendDay(dayKey, monthKey) ? WEEKEND_SHIFTS : WEEKDAY_SHIFTS;
}

function shortenShift(code) {
    const map = { manha: 'D1 08-16', vespertino: 'V 14-20', noturno: 'N 20-08', diurno: 'D 08-20' };
    return map[code] || code;
}

async function loadSchedule(monthKey) {
    try {
        const response = await fetchWithTimeout(`${SCHEDULE_API}?month=${encodeURIComponent(monthKey)}`);
        const data = await response.json();
        return data.success ? data.entries || [] : [];
    } catch (error) {
        console.error('Error loading schedule:', error);
        return [];
    }
}

async function saveScheduleEntry(entry) {
    try {
        const response = await fetchWithTimeout(SCHEDULE_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entry })
        });
        const data = await response.json();
        if (!data.success) {
            console.error('saveScheduleEntry failed:', data);
        }
    } catch (error) {
        console.error('Error saving schedule entry:', error);
        throw error; // re-throw so callers can handle
    }
}

// Id helpers (Azure Table rowKey cannot contain / \ # ?)
function makeShiftId(dayKey, shiftCode) {
    return `${dayKey.replace('/', '-')}__${shiftCode}`;
}
function parseShiftId(id) {
    const [datePart, shiftCode] = (id || '').split('__');
    if (!datePart || !shiftCode) return null;
    const [dd, mm] = datePart.split('-');
    if (!dd || !mm) return null;
    return { dayKey: `${dd}/${mm}`, shiftCode };
}

// Merge backend entries (keyed by "DD-MM__shiftCode") into the local seed data
function mergeScheduleEntries(seed, backendEntries) {
    const merged = JSON.parse(JSON.stringify(seed.entries || {}));
    for (const e of backendEntries) {
        const parsed = parseShiftId(e.id);
        if (!parsed) continue;
        const { dayKey, shiftCode } = parsed;
        if (!merged[dayKey]) merged[dayKey] = {};
        merged[dayKey][shiftCode] = { assignedTo: e.assignedTo || '', swapTo: e.swapTo || '' };
    }
    return merged;
}

async function renderSchedule() {
    const grid = $('scheduleGrid');
    const meta = $('scheduleMeta');
    if (!grid || !meta) return;

    const now = new Date();
    const month = new Date(now.getFullYear(), now.getMonth() + scheduleMonthOffset, 1);
    const monthKey = `${month.getFullYear()}-${String(month.getMonth()+1).padStart(2,'0')}`;
    const seed = scheduleData[monthKey] || scheduleData['2026-04'];
    const today = new Date();
    const todayKey = `${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')}`;
    const backendEntries = await loadSchedule(monthKey);
    const entries = mergeScheduleEntries(seed, backendEntries);

    meta.innerHTML = `
        <div>${seed.title}</div>
        <div style="font-size: 13px; color: #666; margin-top: 6px;">
            <strong>Seg-Sex:</strong> Diarista G1 08-16 (Janio) · Vesp. 14-20 · Not. 20-08 &nbsp;|&nbsp; <strong>Sáb-Dom:</strong> Diurno 08-20 · Not. 20-08
        </div>
    `;

    const weekdayNames = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
    const firstDay = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const cells = [];
    const agendaRows = [];
    for (let i = 0; i < firstDay; i++) cells.push('<div class="calendar-day empty"></div>');
    for (let d = 1; d <= daysInMonth; d++) {
        const dayKey = `${String(d).padStart(2,'0')}/${String(month.getMonth()+1).padStart(2,'0')}`;
        const isWeekend = isWeekendDay(dayKey, monthKey);
        const dow = new Date(month.getFullYear(), month.getMonth(), d).getDay();
        const codes = shiftCodesForDay(dayKey, monthKey);
        const dayEntries = entries[dayKey] || {};
        // Ensure Janio fixo on weekday manha
        if (!isWeekend && !dayEntries.manha) dayEntries.manha = { assignedTo: FIXED_MANHA, swapTo: '' };

        const isToday = dayKey === todayKey;
        const isPast = (function(){
            const today0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
            const cellDate = new Date(month.getFullYear(), month.getMonth(), d);
            return cellDate < today0;
        })();

        const shiftsHtml = codes.map(code => {
            const slot = dayEntries[code] || {};
            const name = typeof slot === 'string' ? slot : (slot.assignedTo || '');
            const swap = typeof slot === 'string' ? '' : (slot.swapTo || '');
            return `<div class="day-shift-row">
                        <span class="shift-tag">${shortenShift(code)}</span>
                        <span class="shift-name">${escapeHtml(name) || '—'}${swap ? ` <em>↔${escapeHtml(swap)}</em>` : ''}</span>
                    </div>`;
        }).join('');

        // Desktop grid cell
        cells.push(`
            <div class="calendar-day clickable ${isToday ? 'today' : ''} ${isWeekend ? 'weekend' : ''}" data-day="${dayKey}">
                <div class="day-number">${d}${isToday ? ' 📍' : ''}</div>
                ${shiftsHtml}
            </div>
        `);

        // Mobile agenda row
        const agendaShifts = codes.map(code => {
            const slot = dayEntries[code] || {};
            const name = typeof slot === 'string' ? slot : (slot.assignedTo || '');
            const swap = typeof slot === 'string' ? '' : (slot.swapTo || '');
            const empty = !name;
            return `<div class="agenda-shift ${empty ? 'empty-slot' : ''}">
                        <span class="agenda-tag">${shortenShift(code)}</span>
                        <span class="agenda-name">${escapeHtml(name) || 'vazio'}</span>
                        ${swap ? `<span class="agenda-swap">↔ ${escapeHtml(swap)}</span>` : ''}
                    </div>`;
        }).join('');

        agendaRows.push(`
            <div class="agenda-day clickable ${isToday ? 'today' : ''} ${isWeekend ? 'weekend' : ''} ${isPast ? 'past' : ''}" data-day="${dayKey}">
                <div class="agenda-date">
                    <div class="agenda-dow">${weekdayNames[dow]}${isToday ? ' • HOJE' : ''}</div>
                    <div class="agenda-daynum">${String(d).padStart(2,'0')}</div>
                </div>
                <div class="agenda-shifts">${agendaShifts}</div>
                <div class="agenda-chevron">›</div>
            </div>
        `);
    }

    grid.innerHTML = `
        <div class="schedule-calendar-grid desktop-only">
            <div class="calendar-header">Dom</div>
            <div class="calendar-header">Seg</div>
            <div class="calendar-header">Ter</div>
            <div class="calendar-header">Qua</div>
            <div class="calendar-header">Qui</div>
            <div class="calendar-header">Sex</div>
            <div class="calendar-header">Sáb</div>
            ${cells.join('')}
        </div>
        <div class="schedule-agenda mobile-only">
            ${agendaRows.join('')}
        </div>
    `;

    // Scroll to today on mobile
    const todayRow = grid.querySelector('.agenda-day.today');
    if (todayRow && window.innerWidth <= 768) {
        setTimeout(() => todayRow.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
    }

    grid.querySelectorAll('.calendar-day.clickable, .agenda-day.clickable').forEach(cell => {
        cell.addEventListener('click', () => {
            const dayKey = cell.dataset.day;
            openScheduleEditor(dayKey, entries[dayKey] || {}, monthKey);
        });
    });
}

function openScheduleEditor(dayKey, dayEntries, monthKey) {
    const existing = $('scheduleEditorModal');
    if (existing) existing.remove();

    const isWeekend = isWeekendDay(dayKey, monthKey);
    const codes = shiftCodesForDay(dayKey, monthKey);

    const rowsHtml = codes.map(code => {
        const slot = dayEntries[code] || {};
        const name = typeof slot === 'string' ? slot : (slot.assignedTo || '');
        const swap = typeof slot === 'string' ? '' : (slot.swapTo || '');
        const locked = (!isWeekend && code === 'manha'); // Janio fixo
        const val = locked ? FIXED_MANHA : name;
        return `
            <div class="shift-row">
                <label>${SHIFT_LABELS[code]}${locked ? ' <small>(fixo)</small>' : ''}</label>
                <input type="text" data-code="${code}" data-field="assignedTo"
                       value="${escapeHtml(val)}"
                       placeholder="Profissional"
                       ${locked ? 'disabled' : ''}>
                <input type="text" data-code="${code}" data-field="swapTo"
                       value="${escapeHtml(swap)}"
                       placeholder="Troca com (opcional)">
            </div>
        `;
    }).join('');

    const modal = document.createElement('div');
    modal.id = 'scheduleEditorModal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="modal-box">
            <div class="modal-header">
                <h3>Escala de ${dayKey}</h3>
                <button class="modal-close">&times;</button>
            </div>
            <div class="modal-body">
                ${rowsHtml}
            </div>
            <div class="modal-footer">
                <button class="btn btn-secondary" id="modalClearBtn">Limpar turnos</button>
                <button class="btn btn-primary" id="modalSaveBtn">Salvar</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('.modal-close').addEventListener('click', close);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    modal.querySelector('#modalSaveBtn').addEventListener('click', async () => {
        const payload = {};
        modal.querySelectorAll('input[data-code]').forEach(inp => {
            const code = inp.dataset.code;
            const field = inp.dataset.field;
            if (!payload[code]) payload[code] = { assignedTo: '', swapTo: '' };
            payload[code][field] = inp.value.trim();
        });
        // Save each shift as its own record
        try {
            await Promise.all(codes.map(code => {
                const slot = payload[code] || { assignedTo: '', swapTo: '' };
                return saveScheduleEntry({
                    id: makeShiftId(dayKey, code),
                    month: monthKey,
                    shift: SHIFT_LABELS[code],
                    assignedTo: slot.assignedTo,
                    swapTo: slot.swapTo,
                    notes: slot.swapTo ? `Troca: ${slot.swapTo}` : ''
                });
            }));
            close();
            await renderSchedule();
        } catch (error) {
            showError('Erro ao salvar escala. Tente novamente.');
        }
    });

    modal.querySelector('#modalClearBtn').addEventListener('click', async () => {
        try {
            await Promise.all(codes.map(code => {
                const id = makeShiftId(dayKey, code);
                return fetchWithTimeout(`${SCHEDULE_API}/${encodeURIComponent(id)}?month=${encodeURIComponent(monthKey)}`, { method: 'DELETE' });
            }));
            close();
            await renderSchedule();
        } catch (error) {
            console.error('Error clearing schedule:', error);
            showError('Erro ao limpar escala. Tente novamente.');
        }
    });
}

// Utility Functions
function generateId() {
    return 'pat_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function getPriorityClass(priority) {
    const map = { 'Alta': 'high', 'Média': 'medium', 'Baixa': 'low' };
    return map[priority] || 'low';
}

function formatDateTime(isoString) {
    if (!isoString) return 'Data desconhecida';
    
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    
    if (diffMins < 1) return 'Agora';
    if (diffMins < 60) return `${diffMins} min atrás`;
    
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h atrás`;
    
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d atrás`;
    
    return date.toLocaleDateString('pt-BR');
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function showLoading(show) {
    const ls = $('loadingState'); if (ls) ls.style.display = show ? 'flex' : 'none';
    const pg = $('patientsGrid'); if (pg) pg.style.display = show ? 'none' : 'grid';
}

function showSuccess(message) {
    alert(message);
}

function showError(message) {
    alert('❌ ' + message);
}

function updatePrintView() {
    const printList = $('printList');
    const printMeta = $('printMeta');
    if (!printList || !printMeta) return;

    const sorted = [...filteredPatients].sort((a, b) => (a.bedNumber || '').localeCompare(b.bedNumber || '', 'pt-BR', { numeric: true }));
    printMeta.textContent = `${sorted.length} paciente(s) • Gerado em ${new Date().toLocaleString('pt-BR')}`;
    printList.innerHTML = sorted.map(buildPatientPrintRow).join('');
}

function openPrintView() {
    openPrintWindow('Bloqueador de pop-up impediu a abertura da impressão.');
}

function exportPdfFromBrowser() {
    openPrintWindow('Bloqueador de pop-up impediu a abertura do PDF.');
}

function openPrintWindow(blockedMessage) {
    const printHtml = buildPrintHtml();
    const win = window.open('', '_blank', 'width=1200,height=800');
    if (!win) {
        showError(blockedMessage);
        return;
    }
    win.document.open();
    win.document.write(printHtml);
    win.document.close();
    win.focus();
    win.onload = () => {
        win.print();
    };
}

function buildPatientPrintRow(patient) {
    return `
        <article class="print-patient">
            <header class="print-patient-header">
                <h3>${escapeHtml(patient.name)}</h3>
                <div class="print-badges">
                    <span class="print-badge">Leito ${escapeHtml(patient.bedNumber || '-')}</span>
                    <span class="print-badge">${escapeHtml(patient.priority || 'Baixa')}</span>
                </div>
            </header>
            <div class="print-row"><strong>DIH:</strong> ${calculateDIH(patient.admissionDate) ?? '-'}</div>
            <div class="print-row"><strong>Admissão:</strong> ${patient.admissionDate || '-'}</div>
            <div class="print-row"><strong>Diagnóstico:</strong> ${escapeHtml(patient.diagnosis || '-')}</div>
            <div class="print-row"><strong>Antimicrobianos:</strong> ${normalizeAntibiotics(patient.antibiotics).map(ab => `${escapeHtml(ab.name)}${ab.startDate ? ` (${ab.startDate})` : ''}`).join(', ') || '-'}</div>
            <div class="print-row"><strong>Condição Atual:</strong> ${escapeHtml(patient.currentCondition || '-')}</div>
            <div class="print-row"><strong>Pendências:</strong> ${escapeHtml(patient.pendingActions || '-')}</div>
            <div class="print-row"><strong>Próximos Passos:</strong> ${escapeHtml(patient.nextSteps || '-')}</div>
            <div class="print-row"><strong>Autor:</strong> ${escapeHtml(patient.author || '-')}</div>
        </article>
    `;
}

function buildPrintHtml() {
    const sorted = [...filteredPatients].sort((a, b) => (a.bedNumber || '').localeCompare(b.bedNumber || '', 'pt-BR', { numeric: true }));
    const rows = sorted.map(buildPatientPrintRow).join('');

    return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Passômetro PDF</title><link rel="stylesheet" href="styles.css"></head><body><section class="print-area" style="display:block;padding:24px;background:#fff"><div class="print-header"><h2>Passômetro - Relatório de Pacientes</h2><p>${sorted.length} paciente(s) • ${new Date().toLocaleString('pt-BR')}</p></div><div class="print-list">${rows || '<p>Nenhum paciente para imprimir.</p>'}</div></section><script>window.onload=()=>window.print();</script></body></html>`;
}

// Close modal when clicking outside
window.addEventListener('click', function(event) {
    const modal = $('patientModal');
    if (modal && event.target === modal) {
        closeModal();
    }
});

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // ESC to close modal
    if (e.key === 'Escape') {
        const modal = $('patientModal');
        if (modal && modal.style.display !== 'none') {
            closeModal();
        }
        const scheduleEditor = $('scheduleEditorModal');
        if (scheduleEditor) {
            scheduleEditor.remove();
        }
    }
    
    // Ctrl/Cmd + K to focus search
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        const searchInput = $('searchInput');
        if (searchInput) searchInput.focus();
    }
});
