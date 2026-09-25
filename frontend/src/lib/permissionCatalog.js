import {
  Layers, Briefcase, Fingerprint, FileText, Calendar, BarChart2, CheckCircle,
  Activity, Target, Users as UsersIcon, Eye, Star, User as UserIcon,
  ShieldCheck, Receipt, MessageSquare, MessageCircle, ArrowUpRight, Clock,
  Edit, Bell, Download, Settings, Trash2, XCircle, Inbox, MapPin, Pencil, Zap,
} from 'lucide-react';

// Canonical permission catalog shared by People Matrix → Users → Permissions and Admin → Permission Matrix.

export const GLOBAL_PERMS = [
  { key: 'can_view_all_tasks',               label: 'Universal Task Access',        desc: 'See tasks assigned to any user or department',           icon: Layers      },
  { key: 'can_view_all_clients',             label: 'Master Client List',           desc: 'View all company legal entities',                        icon: Briefcase   },
  { key: 'can_view_all_dsc',                label: 'DSC Vault Access',             desc: 'View all Digital Signature Certificates',                icon: Fingerprint },
  { key: 'can_view_documents',              label: 'Document Library',             desc: 'Access physical document register',                      icon: FileText    },
  { key: 'can_view_all_duedates',           label: 'Compliance Calendar',           desc: 'View compliance due dates (embedded in Compliance Tracker)',            icon: Calendar    },
  { key: 'can_view_reports',               label: 'Analytics Dashboard',           desc: 'View performance and system-wide reports',               icon: BarChart2   },
  { key: 'can_view_todo_dashboard',         label: 'Todo Dashboard',               desc: 'Access global team todo overview',                       icon: CheckCircle },
  { key: 'can_view_audit_logs',             label: 'System Audit Trail',           desc: 'View activity logs and record histories',                icon: Activity    },
  { key: 'can_view_all_leads',             label: 'Leads Pipeline',               desc: 'View the global leads dashboard',                        icon: Target      },
  { key: 'can_view_user_page',              label: 'User Directory',               desc: 'View team members directory',                            icon: UsersIcon   },
  { key: 'can_view_selected_users_reports', label: 'Team Reports Access',         desc: 'View reports for selected users',                        icon: Eye         },
  { key: 'can_view_staff_rankings',         label: 'Staff Rankings',               desc: 'View performance leaderboard',                           icon: Star        },
  { key: 'can_view_own_data',               label: 'View Own Data',                desc: 'Access own attendance, tasks and reports',               icon: UserIcon    },
  { key: 'can_view_compliance',             label: 'Compliance Tracker',           desc: 'Access the Compliance Tracker page',                     icon: ShieldCheck },
  { key: 'can_view_gst_reconciliation',     label: 'GST Reconciliation',           desc: 'Access the GST Reconciliation module (GST dept users)',  icon: FileText    },
  { key: 'can_create_quotations',           label: 'Quotations Module',            desc: 'Create, edit, export and share quotations',              icon: Receipt     },
  { key: 'can_manage_whatsapp',             label: 'WhatsApp Settings',            desc: 'Access and configure WhatsApp integration settings',     icon: MessageSquare },
  { key: 'can_access_whatsapp_hub', label: 'WhatsApp Hub', desc: 'Access the WhatsApp Hub multi-account inbox', icon: MessageCircle },
  { key: 'can_view_recruitment',    label: 'Recruitment (view)',   desc: 'Access the Recruitment page — candidate pipeline & interviews', icon: Briefcase },
  { key: 'can_manage_recruitment',  label: 'Recruitment (manage)', desc: 'Create, edit and delete candidates, and convert hires to users', icon: Briefcase },
];

export const OPS_PERMS = [
  { key: 'can_assign_tasks',        label: 'Task Delegation',        desc: 'Assign tasks to other users',              icon: ArrowUpRight },
  { key: 'can_assign_clients',      label: 'Client Assignment',      desc: 'Assign and reassign users to clients',             icon: Briefcase    },
  { key: 'can_manage_users',        label: 'User Governance',        desc: 'Manage team members and roles',                    icon: UsersIcon    },
  { key: 'can_view_attendance',     label: 'Attendance Management',  desc: 'Review punch timings and late reports',            icon: Clock        },
  { key: 'can_edit_attendance',    label: 'Edit Attendance',        desc: 'Edit past attendance records (mark absent, half day, leave)',  icon: Edit         },
  { key: 'can_send_reminders',      label: 'Automated Reminders',    desc: 'Trigger email/notification reminders',             icon: Bell         },
  { key: 'can_receive_popup_reminders', label: 'Popup Reminders',    desc: 'Receive on-screen popup reminders (also requires Cross Visibility to be on for this user)', icon: Bell },
  { key: 'can_download_reports',    label: 'Export Data',            desc: 'Download CSV/PDF versions of reports',             icon: Download     },
  { key: 'can_manage_settings',     label: 'System Settings',        desc: 'Modify global system configuration',               icon: Settings     },
  { key: 'can_delete_data',         label: 'Delete Records',         desc: 'Permanently delete data entries',                  icon: Trash2       },
  { key: 'can_delete_tasks',        label: 'Delete Tasks',           desc: 'Delete any task regardless of ownership',          icon: XCircle      },
  { key: 'can_connect_email',       label: 'Connect Email Accounts', desc: 'Link personal email via IMAP integration',         icon: Inbox        },
  { key: 'can_view_all_visits',     label: 'View All Visits',        desc: 'See client visits logged by any user',     icon: MapPin       },
  { key: 'can_edit_visits',         label: 'Edit Visits',            desc: 'Edit and update client visit records',             icon: Edit         },
  { key: 'can_delete_visits',       label: 'Delete Any Visit',       desc: 'Delete visit records belonging to any user',      icon: Trash2       },
  { key: 'can_delete_own_visits',   label: 'Delete Own Visits',      desc: 'Delete only their own logged visit records',       icon: XCircle      },
];

export const EDIT_PERMS = [
  { key: 'can_edit_tasks',     label: 'Modify Tasks',     desc: 'Update and delete task definitions',       icon: Pencil      },
  { key: 'can_edit_clients',   label: 'Modify Clients',   desc: 'Update client master data records',        icon: Edit        },
  { key: 'can_edit_dsc',       label: 'Modify DSC',       desc: 'Update certificate details and metadata',  icon: Fingerprint },
  { key: 'can_edit_documents', label: 'Modify Documents', desc: 'Change document records',                  icon: FileText    },
  { key: 'can_edit_due_dates', label: 'Modify Due Dates', desc: 'Add, edit & delete due dates in the Compliance Calendar panel',      icon: Calendar    },
  { key: 'can_edit_users',     label: 'Modify Users',     desc: 'Update user profiles and settings',        icon: UserIcon    },
];

export const permTabs = [
  { id: 'modules', label: 'Modules',    icon: Zap       },
  { id: 'view',    label: 'View',        icon: Eye       },
  { id: 'ops',     label: 'Operations',  icon: Settings  },
  { id: 'edit',    label: 'Edit',        icon: Pencil    },
  { id: 'cross',   label: 'Cross-User',  icon: UsersIcon },
  { id: 'clients', label: 'Clients',     icon: Briefcase },
];



export const MODULE_PERM_KEYS = [
  'can_manage_invoices', 'can_view_sale', 'can_view_purchase', 'can_view_bank',
  'can_view_chart_of_accounts', 'can_manage_chart_of_accounts', 'can_view_journal_entries', 'can_post_journal_entries',
  'can_match_bank', 'can_view_accounting_reports', 'can_view_passwords', 'can_edit_passwords',
  'can_view_gst_reconciliation', 'can_view_trademark_sphere', 'can_view_client_portal', 'can_reset_client_passwords',
  'can_manage_whatsapp', 'can_create_quotations', 'can_view_mis_report', 'can_manage_mis_report',
  'can_view_salary_slips', 'can_manage_salary_slips', 'can_view_recruitment', 'can_manage_recruitment',
  'can_access_taskosphere', 'can_access_finix', 'can_access_compliance', 'can_access_records',
  'can_access_proposals', 'can_access_people_matrix', 'can_access_aiweave',
];
