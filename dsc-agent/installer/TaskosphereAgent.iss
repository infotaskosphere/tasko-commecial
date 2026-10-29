; Taskosphere Agent installer (Inno Setup 6).
; Built by .github/workflows/dsc-agent-installer.yml:
;   ISCC /DAppVersion=4.1.0 installer\TaskosphereAgent.iss
; Per-user install: no administrator rights needed.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6C2E5C1B-3F7A-4D2E-9B6F-1A7E2D4C8B91}
AppName=Taskosphere Agent
AppVersion={#AppVersion}
AppVerName=Taskosphere Agent {#AppVersion}
AppPublisher=Taskosphere
AppPublisherURL=https://taskosphere.com
DefaultDirName={localappdata}\Programs\Taskosphere Agent
DisableDirPage=yes
DisableProgramGroupPage=yes
DefaultGroupName=Taskosphere Agent
PrivilegesRequired=lowest
OutputDir=..\dist
OutputBaseFilename=TaskosphereAgentSetup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Taskosphere Agent
UninstallDisplayIcon={app}\TaskosphereAgent.exe
CloseApplications=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Files]
Source: "..\dist\TaskosphereAgent.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "start-agent.vbs"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\Taskosphere Agent"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-agent.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\TaskosphereAgent.exe"
Name: "{group}\Uninstall Taskosphere Agent"; Filename: "{uninstallexe}"

[Registry]
; Start automatically when the user signs in to Windows.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "TaskosphereAgent"; ValueData: """{sys}\wscript.exe"" ""{app}\start-agent.vbs"""; Flags: uninsdeletevalue

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\start-agent.vbs"""; WorkingDir: "{app}"; Description: "Start Taskosphere Agent now"; Flags: postinstall nowait

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM TaskosphereAgent.exe"; Flags: runhidden; RunOnceId: "StopAgent"
Filename: "{sys}\schtasks.exe"; Parameters: "/Delete /TN TaskosphereAgent /F"; Flags: runhidden; RunOnceId: "RemoveOldTask"

[Code]
// Stop a running copy before files are replaced (upgrades), and remove the
// scheduled task older manual setups created with --install-service, so the
// agent is not started twice.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM TaskosphereAgent.exe', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\schtasks.exe'), '/Delete /TN TaskosphereAgent /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
