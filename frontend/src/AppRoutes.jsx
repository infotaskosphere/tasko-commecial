          <Route path="/accounting-books" element={<ModuleGate module="finix"><AccountingBooks /></ModuleGate>} />
          <Route path="/zero-touch-entry" element={<Navigate to="/purchase" replace />} />
          <Route path="/gst-portal-sync" element={<ModuleGate module="finix"><GSTPortalSync /></ModuleGate>} />
          <Route path="/accounting-integrity" element={<ModuleGate module="finix"><AccountingIntegrity /></ModuleGate>} />
          <Route path="/day-book" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/cash-bank-book" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/cash-flow" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/outstanding-report" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/bank-reconciliation" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/depreciation" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/tds-tcs" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/financial-ratios" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/comparative-report" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/yearly-report" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/opening-balances" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/accounting-audit-trail" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/bulk-import" element={<ModuleGate module="finix"><ExtendedReports /></ModuleGate>} />
          <Route path="/due-dates" element={<ModuleGate module="finix"><DueDates /></ModuleGate>} />
          <Route path="/import-invoices" element={<ModuleGate module="finix"><ImportInvoices /></ModuleGate>} />

          <Route path="/people-matrix" element={<ModuleGate module="peopleMatrix"><PeopleMatrixDashboard /></ModuleGate>} />
          <Route path="/reports" element={<AdminOnly><LinkedAdminPageGate module="taskosphere" page="can_view_reports"><Reports /></LinkedAdminPageGate></AdminOnly>} />
          <Route path="/task-audit" element={<AdminOnly><LinkedAdminPageGate module="taskosphere" page="can_view_audit_logs"><TaskAudit /></LinkedAdminPageGate></AdminOnly>} />
          <Route path="/users" element={<AdminOnly><PeopleMatrixPageFrame page="users"><Users /></PeopleMatrixPageFrame></AdminOnly>} />
          <Route path="/staff-activity" element={<AdminOnly><LinkedAdminPageGate module="taskosphere" page="can_view_staff_activity"><StaffActivity /></LinkedAdminPageGate></AdminOnly>} />
          <Route path="/whatsapp-hub" element={<AdminOnly><LinkedAdminPageGate module="records" page="can_access_whatsapp_hub"><WhatsAppHub /></LinkedAdminPageGate></AdminOnly>} />
          <Route path="/leave" element={<ModuleGate module="peopleMatrix"><PageGuard module="people_matrix" page="can_view_leave"><PeopleMatrixPageFrame page="leave"><Leave /></PeopleMatrixPageFrame></PageGuard></ModuleGate>} />
          <Route path="/payroll" element={<ModuleGate module="peopleMatrix"><PageGuard module="people_matrix" page="can_view_payroll"><PeopleMatrixPageFrame page="payroll"><Payroll /></PeopleMatrixPageFrame></PageGuard></ModuleGate>} />
          <Route path="/hr" element={<ModuleGate module="peopleMatrix"><PageGuard module="people_matrix" page="can_view_hr"><PeopleMatrixPageFrame page="hr"><HR /></PeopleMatrixPageFrame></PageGuard></ModuleGate>} />
          <Route path="/recruitment" element={<ModuleGate module="peopleMatrix"><PageGuard module="people_matrix" page="can_view_recruitment"><Recruitment /></PageGuard></ModuleGate>} />
          <Route path="/client-discussion" element={<ModuleGate module="proposals"><PageGuard module="proposals" page="can_view_client_discussion"><ClientDiscussion /></PageGuard></ModuleGate>} />

          <Route path="/engagex" element={<EngageXGate><EngageXDashboard /></EngageXGate>} />
          <Route path="/engagex/whatsapp" element={<EngageXGate><EngageXWhatsAppHub /></EngageXGate>} />
          <Route path="/engagex/mailmaster" element={<EngageXGate><EngageXMailMaster /></EngageXGate>} />

          <Route path="/admin-dashboard" element={<AdminOnly><AdminDashboard /></AdminOnly>} />
          <Route path="/permission-matrix" element={<AdminOnly><PermissionMatrix /></AdminOnly>} />
          <Route path="/master-data" element={<AdminOnly><PageGuard module="admin" page="can_view_master_data"><MasterData /></PageGuard></AdminOnly>} />
          <Route path="/roles" element={<AdminOnly><PageGuard module="admin" page="can_view_roles"><Roles /></PageGuard></AdminOnly>} />
          <Route path="/contact-details" element={<AdminOnly><ContactDetails /></AdminOnly>} />