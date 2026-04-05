# Passômetro — Bug Fixes

Patches para o Passômetro (https://passometro.azurewebsites.net) identificados em sessão de debug em 2026-04-05.

## Bugs identificados

### 🐛 Bug 1 — Alerta "Paciente atualizado!" aparece ao ADICIONAR novo paciente

**Arquivo:** `medishift-planner.js` (deployado em `/home/site/wwwroot/medishift-planner.js` na VM ou Azure Web App).

**Causa:** A função `savePatient()` decidia a mensagem com base em `patientData.id`, mas esse campo é **sempre** preenchido em `handleFormSubmit()` (via hidden field ou via `generateId()`). Portanto a condição ternária era sempre truthy, e o alerta sempre mostrava "Paciente atualizado!".

**Fix aplicado:**

- `handleFormSubmit()` agora lê o hidden field `patientId` **antes** de gerar um ID novo e determina `isNew = !existingId`.
- `savePatient(patientData, isNew)` recebe a flag como segundo parâmetro e escolhe a mensagem correta.

Diff:
```diff
-async function savePatient(patientData) {
+async function savePatient(patientData, isNew = false) {
     ...
-    showSuccess(patientData.id ? 'Paciente atualizado!' : 'Paciente adicionado!');
+    showSuccess(isNew ? 'Paciente adicionado!' : 'Paciente atualizado!');

 async function handleFormSubmit(e) {
     e.preventDefault();
+    const existingId = document.getElementById('patientId').value;
+    const isNew = !existingId;
     const patientData = {
-        id: document.getElementById('patientId').value || generateId(),
+        id: existingId || generateId(),
         ...
-    await savePatient(patientData);
+    await savePatient(patientData, isNew);
```

### 🐛 Bug 2 — Botão "Excluir" não exclui de verdade (backend)

**Status:** NÃO corrigido neste patch (requer mudança no backend `api.js`).

**Causa:** O frontend envia `POST /api/patients` com body `{"action":"deletePatient","id":"..."}`. O backend ignora o `action` e trata como `savePatient`, sobrescrevendo o registro com campos vazios (preserva só o id).

**Evidência:** Durante o debug, clicar em "Excluir" via UI retornou `{"success":true}` + alerta "Paciente excluído!", mas `GET /api/patients` continuou retornando o paciente com nome/leito/etc. vazios.

**Fix recomendado (backend):** adicionar handler para `action: 'deletePatient'` OU para `DELETE /api/patients/:id` que de fato remove da tabela (Azure Table Storage).

## Deploy

Substituir `/home/site/wwwroot/medishift-planner.js` no Azure Web App `passometro` pelo `medishift-planner.js` desta pasta.

Caminhos possíveis:

1. **SSH VM Azure + scp:** `scp medishift-planner.js openclaw@48.202.56.200:~/.openclaw/workspace/azure-espaçometro/` e redeploy.
2. **Kudu SCM:** editar direto via `https://passometro.scm.azurewebsites.net/DebugConsole`.
3. **Git push para Azure Web App** (se tiver configurado).

## Limpeza de dados de teste

Durante o debug, foram criados estes pacientes de teste que precisam ser removidos (o que ficou bloqueado pelo Bug 2):

- `frontend-test-001` (corrompido, campos vazios)
- `pat_test_simple` (corrompido)
- `test-paciente-debug` (corrompido)
- `pat_1775359829406_hn56x5hb6` (nome: "Paciente Debug UI", leito 10)
- `pat_fix_test_1775359993329` (nome: "Teste Fix", leito 99)

Real paciente a manter: `test-1` (Kiyo Hirata, leito 05).
