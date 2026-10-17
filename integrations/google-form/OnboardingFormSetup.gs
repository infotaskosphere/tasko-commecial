/**
 * Creates the actual Google Form used for OneNexa commercial licensee onboarding.
 *
 * This file is intentionally standalone: it does not use any Apps Script library.
 * Run createCommercialLicenseeOnboardingForm() once from Apps Script.
 * The execution log will contain the public form URL and edit URL.
 */
function createCommercialLicenseeOnboardingForm() {
  var props = PropertiesService.getScriptProperties();
  var existingId = props.getProperty('ONENEXA_FORM_ID');
  if (existingId) {
    try {
      var existing = FormApp.openById(existingId);
      Logger.log('Form already exists: ' + existing.getPublishedUrl());
      Logger.log('Edit URL: ' + existing.getEditUrl());
      return existing.getPublishedUrl();
    } catch (e) {
      props.deleteProperty('ONENEXA_FORM_ID');
    }
  }

  var form = FormApp.create('OneNexa Commercial Licensee Onboarding');
  form.setDescription(
    'Commercial licensee onboarding application for OneNexa. Complete all applicable business, licensing, deployment and implementation details. Your application will be reviewed by the OneNexa Commercial Console team before a license is issued.'
  );
  form.setConfirmationMessage(
    'Thank you. Your OneNexa commercial onboarding application has been submitted successfully. Our team will review the application and contact you for the next steps.'
  );
  form.setCollectEmail(false);

  function text(title, help, required) {
    var item = form.addTextItem().setTitle(title);
    if (help) item.setHelpText(help);
    item.setRequired(required !== false);
    return item;
  }
  function paragraph(title, help, required) {
    var item = form.addParagraphTextItem().setTitle(title);
    if (help) item.setHelpText(help);
    item.setRequired(required !== false);
    return item;
  }
  function choice(title, values, help, required) {
    var item = form.addMultipleChoiceItem().setTitle(title).setChoiceValues(values);
    if (help) item.setHelpText(help);
    item.setRequired(required !== false);
    return item;
  }
  function checkbox(title, values, help, required) {
    var item = form.addCheckboxItem().setTitle(title).setChoiceValues(values);
    if (help) item.setHelpText(help);
    item.setRequired(required !== false);
    return item;
  }

  form.addSectionHeaderItem().setTitle('1. Applicant & Organization Details');
  text('Legal / Registered Name', 'Exact legal name as per PAN/GST/registration records.');
  text('Trade / Brand Name', 'Optional trading or customer-facing brand name.', false);
  choice('Constitution / Entity Type', ['Private Limited Company', 'Public Limited Company', 'LLP', 'Partnership Firm', 'Proprietorship', 'Trust / Society', 'Individual / Professional', 'Other']);
  text('PAN', 'PAN of the proposed licensee organization.');
  text('GSTIN', 'Enter GSTIN if registered.', false);
  text('CIN / LLPIN / Registration No.', 'Company/LLP/other registration number where applicable.', false);
  paragraph('Registered Office Address');
  text('City');
  text('State');
  text('PIN Code');
  text('Website', 'Official website, if available.', false);

  form.addSectionHeaderItem().setTitle('2. Authorized Contact');
  text('Contact Person Name');
  text('Designation');
  text('Official Email');
  text('Mobile Number');
  text('Alternate Contact / Email', 'Optional secondary contact.', false);

  form.addSectionHeaderItem().setTitle('3. Business & OneNexa Requirements');
  choice('Primary Business Type', ['CA / CS / Professional Services', 'Accounting / Finance', 'Legal / Compliance', 'Manufacturing', 'Trading', 'Services', 'Education', 'Technology / IT', 'Other']);
  paragraph('Brief description of your business and intended use of OneNexa', 'Explain what your organization wants to manage in OneNexa and the expected workflow.');
  text('Approximate Number of Clients / Entities to be Managed', 'Example: 250 clients / 80 group entities.', false);
  checkbox('Modules Requested', ['Taskosphere', 'Finix / Accounting', 'AIWeave', 'CompliGenie / Compliance', 'Records', 'LeadSense / Proposals', 'People Matrix / HR'], 'Select all modules required for the commercial proposal.');
  choice('License Model', ['Single company / licensee', 'Multi-company / group', 'White label', 'Reseller / partner', 'Enterprise']);
  text('Expected Number of Users', 'Number of users expected to operate the license. Example: 10.');
  text('Expected Number of Companies / Entities', 'Number of companies/entities expected under the license.', false);
  paragraph('Additional Modules / Commercial Requirements', 'Mention any special module, workflow, reporting or commercial requirement.', false);

  form.addSectionHeaderItem().setTitle('4. Deployment, Migration & Isolation');
  choice('Preferred Deployment', ['Cloud Hosted', 'Private Cloud / Dedicated Server', 'On-Premise / Local Network', 'To be discussed']);
  choice('Data Migration Required?', ['No', 'Yes', 'To be discussed']);
  paragraph('If migration is required, describe current software/database and approximate data volume', 'Example: Tally + Excel, 5 years, 50,000 records.', false);
  choice('Need Separate / Isolated Licensee Data Environment?', ['Yes – Dedicated / Isolated', 'No – Shared Control Plane Only', 'To be discussed']);
  choice('Custom Branding Required?', ['No', 'Yes']);
  text('Preferred Product / White-label Name', 'Complete only if custom branding or white-label is required.', false);
  text('Custom Domain', 'Example: app.yourcompany.com', false);

  form.addSectionHeaderItem().setTitle('5. Integrations & Implementation');
  checkbox('Required Integrations', ['GST / Tax', 'Email / SMTP', 'WhatsApp / Messaging', 'Payment Gateway', 'Banking / Bank Statements', 'Tally / Accounting Software', 'API / Custom Integration', 'None'], 'Select all that apply.', false);
  text('Target Implementation / Go-live Date', 'Example: 15/11/2026.', false);
  paragraph('Implementation, Training, Support or Special Requirements', 'Mention onboarding, migration, training, SLA, support or integration expectations.', false);
  paragraph('Additional Notes', 'Any other information that should be considered during commercial review.', false);

  form.addSectionHeaderItem().setTitle('6. Declaration');
  checkbox('Declaration', ['I confirm that the information provided in this application is accurate and complete and I authorize OneNexa to contact me regarding this commercial onboarding request.'], null, true);

  props.setProperty('ONENEXA_FORM_ID', form.getId());
  props.setProperty('ONENEXA_FORM_URL', form.getPublishedUrl());
  props.setProperty('ONENEXA_FORM_EDIT_URL', form.getEditUrl());

  Logger.log('ONENEXA COMMERCIAL ONBOARDING FORM URL: ' + form.getPublishedUrl());
  Logger.log('ONENEXA FORM EDIT URL: ' + form.getEditUrl());
  return form.getPublishedUrl();
}

function installCommercialOnboardingTrigger() {
  var formId = PropertiesService.getScriptProperties().getProperty('ONENEXA_FORM_ID');
  if (!formId) throw new Error('Run createCommercialLicenseeOnboardingForm() first.');
  var form = FormApp.openById(formId);

  ScriptApp.getProjectTriggers().forEach(function(trigger) {
    if (trigger.getHandlerFunction() === 'forwardOnboardingFormSubmit') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('forwardOnboardingFormSubmit')
    .forForm(form)
    .onFormSubmit()
    .create();

  Logger.log('Commercial onboarding trigger installed. Form URL: ' + form.getPublishedUrl());
}

function getCommercialOnboardingFormLink() {
  var url = PropertiesService.getScriptProperties().getProperty('ONENEXA_FORM_URL');
  if (!url) throw new Error('Run createCommercialLicenseeOnboardingForm() first.');
  Logger.log(url);
  return url;
}
