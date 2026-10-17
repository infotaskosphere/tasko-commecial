/**
 * OneNexa Google Form -> Commercial Console onboarding queue.
 *
 * In the Apps Script project attached to the Google Form, set Script Properties:
 *   ONENEXA_ONBOARDING_ENDPOINT = https://<your-commercial-backend>/api/commercial-console/onboarding/google-form-submissions
 *   ONENEXA_WEBHOOK_SECRET = <same value as backend COMMERCIAL_ONBOARDING_WEBHOOK_SECRET>
 *
 * Run installOnboardingSubmitTrigger() once. Form submit events are forwarded
 * into the same pending queue shown in Master Console > Onboarding Approval.
 */

function installOnboardingSubmitTrigger() {
  var form = FormApp.getActiveForm();
  if (!form) throw new Error('Open this script from the Google Form via Extensions > Apps Script.');

  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'forwardOnboardingFormSubmit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('forwardOnboardingFormSubmit')
    .forForm(form)
    .onFormSubmit()
    .create();

  Logger.log('OneNexa onboarding submit trigger installed.');
}

function forwardOnboardingFormSubmit(event) {
  if (!event || !event.response) {
    throw new Error('This function must be invoked by the Google Form submit trigger.');
  }

  var props = PropertiesService.getScriptProperties();
  var endpoint = (props.getProperty('ONENEXA_ONBOARDING_ENDPOINT') || '').trim();
  var secret = (props.getProperty('ONENEXA_WEBHOOK_SECRET') || '').trim();
  if (!endpoint) throw new Error('Set ONENEXA_ONBOARDING_ENDPOINT in Script Properties.');
  if (!secret) throw new Error('Set ONENEXA_WEBHOOK_SECRET in Script Properties.');

  var answers = {};
  event.response.getItemResponses().forEach(function(itemResponse) {
    var title = String(itemResponse.getItem().getTitle() || '').trim().toLowerCase();
    answers[title] = itemResponse.getResponse();
  });

  function pick(names, fallback) {
    for (var i = 0; i < names.length; i++) {
      var key = String(names[i]).trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(answers, key) && answers[key] !== '') {
        return answers[key];
      }
    }
    return fallback === undefined ? '' : fallback;
  }

  function list(value) {
    if (Array.isArray(value)) return value;
    if (!value) return [];
    return String(value).split(/[,;\n]/).map(function(v) { return v.trim(); }).filter(Boolean);
  }

  function moduleKey(value) {
    var key = String(value || '').trim().toLowerCase().replace(/-/g, '_');
    var map = {
      'task management': 'taskosphere',
      'taskosphere': 'taskosphere',
      'tasks': 'taskosphere',
      'accounting': 'finix',
      'accounting / finix': 'finix',
      'finix / accounting': 'finix',
      'finix': 'finix',
      'gst / tax': 'compliance',
      'compliance': 'compliance',
      'roc / compliance': 'compliance',
      'trademark / ip': 'compliance',
      'income tax': 'compliance',
      'aiweave': 'aiweave',
      'records': 'records',
      'crm / leads': 'proposals',
      'leadsense': 'proposals',
      'proposals': 'proposals',
      'payroll': 'people_matrix',
      'hr': 'people_matrix',
      'people matrix': 'people_matrix',
      'people_matrix': 'people_matrix'
    };
    return map[key] || map[key.replace(/_/g, ' ')] || key;
  }

  var rawModules = list(pick(['modules requested'], []));
  if (rawModules.length > 1) rawModules = rawModules.filter(function(v) { return String(v).trim().toLowerCase() !== 'other'; });
  var modules = rawModules.map(moduleKey).filter(function(v, i, all) {
    return !!v && all.indexOf(v) === i;
  });

  var rawIntegrations = list(pick(['required integrations'], []));
  var userCount = parseInt(pick(['expected number of users', 'user count'], '10'), 10);
  if (!Number.isFinite(userCount) || userCount < 1) userCount = 10;

  var declarationValue = pick(['declaration'], []);
  var declaration = Array.isArray(declarationValue)
    ? declarationValue.some(function(v) { return /confirm|accurate|agree/i.test(String(v)); })
    : /confirm|accurate|agree|yes/i.test(String(declarationValue));

  var licenseModel = String(pick(['license model'], 'standard')).trim().toLowerCase();
  var licenseMap = {
    'single company / licensee': 'standard',
    'multi-company / group': 'enterprise',
    'white label': 'white_label',
    'reseller / partner': 'reseller',
    'enterprise': 'enterprise',
    'professional': 'professional',
    'standard': 'standard'
  };

  var payload = {
    source: 'google_form',
    legal_name: String(pick(['legal / registered name'])).trim(),
    trade_name: pick(['trade / brand name']) || null,
    constitution: pick(['constitution / entity type']),
    pan: String(pick(['pan'])).trim().toUpperCase(),
    gstin: String(pick(['gstin'])).trim().toUpperCase() || null,
    registration_no: pick(['cin / llpin / registration no.']) || null,
    address: pick(['registered office address']),
    city: pick(['city']),
    state: pick(['state']),
    pin: String(pick(['pin code'])).trim(),
    website: pick(['website']) || null,
    contact_name: pick(['contact person name']),
    designation: pick(['designation']),
    email: String(pick(['official email'])).trim().toLowerCase(),
    mobile: String(pick(['mobile number'])).trim(),
    alternate_contact: pick(['alternate contact / email']) || null,
    business_type: pick(['primary business type']),
    business_description: pick([
      'brief description of your business and intended use of onenexa',
      'business description and intended use of onenexa'
    ]),
    client_count: pick([
      'approximate number of clients / entities to be managed',
      'approximate number of clients / entities'
    ]) || null,
    modules: modules,
    license_type: licenseMap[licenseModel] || 'standard',
    user_count: userCount,
    entity_count: pick(['expected number of companies / entities', 'expected companies / entities']) || null,
    commercial_notes: pick(['additional modules / commercial requirements']) || null,
    deployment: pick(['preferred deployment']) || 'Cloud Hosted',
    migration: pick(['data migration required?']) || 'To be discussed',
    migration_details: pick([
      'if migration is required, describe current software/database and approximate data volume',
      'current software/database and data volume (if migrating)'
    ]) || null,
    isolation: pick([
      'need separate / isolated licensee data environment?',
      'separate / isolated licensee data environment'
    ]) || 'Yes – Dedicated / Isolated',
    branding: pick(['custom branding required?']) || 'No',
    white_label_name: pick(['preferred product / white-label name', 'preferred white-label name']) || null,
    custom_domain: pick(['custom domain']) || null,
    integrations: rawIntegrations,
    go_live_date: pick(['target implementation / go-live date']) || null,
    implementation_notes: pick(['implementation, training, support or special requirements']) || null,
    notes: pick(['additional notes']) || null,
    declaration: declaration
  };

  var missing = [];
  ['legal_name','constitution','pan','address','city','state','pin','contact_name','designation','email','mobile','business_type','business_description'].forEach(function(key) {
    if (!payload[key]) missing.push(key);
  });
  if (!payload.modules.length) missing.push('modules');
  if (!payload.declaration) missing.push('declaration');
  if (missing.length) {
    throw new Error('Google Form response is missing required fields: ' + missing.join(', ') + '. Check Google Form question titles.');
  }

  var response = UrlFetchApp.fetch(endpoint, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Onenexa-Onboarding-Secret': secret },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  var status = response.getResponseCode();
  if (status < 200 || status >= 300) {
    throw new Error('Commercial backend returned HTTP ' + status + ': ' + response.getContentText().slice(0, 1000));
  }
  Logger.log('OneNexa onboarding application accepted: ' + response.getContentText());
}
