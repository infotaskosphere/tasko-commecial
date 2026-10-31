// TaskosphereTray.exe — the Taskosphere Agent's system-tray icon.
//
// Built in CI with the C# compiler that ships with Windows (.NET Framework 4):
//   csc /target:winexe /win32icon:assets\taskosphere.ico /out:dist\TaskosphereTray.exe
//       /r:System.Windows.Forms.dll /r:System.Drawing.dll tray\TaskosphereTray.cs
// (C# 5 syntax only: that compiler has no string interpolation, ?. or out var.)
//
// The agent (TaskosphereAgent.exe) starts it with:
//   --port 7432 --key <per-run secret> --parent <agent pid> --icon <tray.ico>
// It polls  GET  http://127.0.0.1:<port>/tray/state?format=lines
// and sends POST http://127.0.0.1:<port>/tray/command {"cmd": "..."}
// with the X-Tray-Key header. It exits when the agent process ends.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Taskosphere Agent")]
[assembly: AssemblyProduct("Taskosphere Agent")]
[assembly: AssemblyCompany("Taskosphere")]
[assembly: AssemblyDescription("Taskosphere Agent tray icon")]

namespace Taskosphere
{
    static class TrayApp
    {
        static int port = 7432;
        static string key = "";
        static int parentPid = 0;
        static string iconPath = "";

        static NotifyIcon tray;
        static ToolStripMenuItem status;
        static ToolStripMenuItem connect;
        static ToolStripMenuItem sync;
        static string lastNotice = "";

        [STAThread]
        static void Main(string[] args)
        {
            for (int i = 0; i + 1 < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--port": int.TryParse(args[i + 1], out port); break;
                    case "--key": key = args[i + 1]; break;
                    case "--parent": int.TryParse(args[i + 1], out parentPid); break;
                    case "--icon": iconPath = args[i + 1]; break;
                }
            }

            bool firstCopy;
            using (var mutex = new System.Threading.Mutex(true, "Local\\TaskosphereAgentTray", out firstCopy))
            {
                if (!firstCopy) return;

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                tray = new NotifyIcon();
                tray.Icon = LoadIcon();
                tray.Text = "Taskosphere Agent";

                var menu = new ContextMenuStrip();
                var title = new ToolStripMenuItem("Taskosphere Agent");
                title.Enabled = false;
                title.Font = new Font(title.Font, FontStyle.Bold);
                status = new ToolStripMenuItem("Starting...");
                status.Enabled = false;
                connect = new ToolStripMenuItem("Connect to Taskosphere", null, delegate { Send("connect"); });
                var open = new ToolStripMenuItem("Open Taskosphere", null, delegate { Send("open"); });
                sync = new ToolStripMenuItem("Sync now", null, delegate { Send("sync"); });
                var restart = new ToolStripMenuItem("Restart agent", null, delegate { Send("restart"); });
                var exit = new ToolStripMenuItem("Exit", null, delegate { Send("exit"); });
                menu.Items.AddRange(new ToolStripItem[] {
                    title, status, new ToolStripSeparator(), connect, open, sync, new ToolStripSeparator(), restart, exit
                });
                tray.ContextMenuStrip = menu;
                tray.DoubleClick += delegate { Send("open"); };
                tray.BalloonTipClicked += delegate { Send("balloon"); };
                tray.Visible = true;

                var timer = new Timer();
                timer.Interval = 2000;
                timer.Tick += delegate { Tick(); };
                timer.Start();
                Tick();

                // Windows 11 hides new tray icons under the ^ arrow. Once Windows
                // has registered this icon, show it on the taskbar like the
                // others, unless the user already chose otherwise.
                var promote = new Timer();
                promote.Interval = 8000;
                promote.Tick += delegate { promote.Stop(); Promote(); };
                promote.Start();

                Application.Run();
                tray.Visible = false;
                tray.Dispose();
            }
        }

        static Icon LoadIcon()
        {
            try
            {
                if (iconPath.Length > 0 && File.Exists(iconPath)) return new Icon(iconPath);
            }
            catch { }
            try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); }
            catch { return SystemIcons.Application; }
        }

        static bool AgentAlive()
        {
            if (parentPid <= 0) return true;
            try
            {
                var p = Process.GetProcessById(parentPid);
                return !p.HasExited;
            }
            catch { return false; }
        }

        static void Tick()
        {
            if (!AgentAlive()) { Application.Exit(); return; }
            Dictionary<string, string> s;
            try { s = Parse(Call("GET", "/tray/state?format=lines", null)); }
            catch { status.Text = "Agent is starting..."; return; }

            status.Text = Get(s, "status_text", "Running");
            string tip = Get(s, "tooltip", "Taskosphere Agent");
            if (tip.Length > 63) tip = tip.Substring(0, 63);
            tray.Text = tip;
            bool connected = Get(s, "connected", "false") == "true";
            connect.Visible = !connected;
            connect.Text = Get(s, "connect_label", "Connect to Taskosphere");
            sync.Enabled = connected;

            string noticeId = Get(s, "notice_id", "");
            if (noticeId.Length > 0 && noticeId != lastNotice)
            {
                lastNotice = noticeId;
                tray.ShowBalloonTip(10000, Get(s, "notice_title", "Taskosphere Agent"), Get(s, "notice_text", " "), ToolTipIcon.Info);
            }
        }

        static void Promote()
        {
            try
            {
                using (var root = Registry.CurrentUser.OpenSubKey("Control Panel\\NotifyIconSettings", true))
                {
                    if (root == null) return;
                    foreach (string name in root.GetSubKeyNames())
                    {
                        using (var k = root.OpenSubKey(name, true))
                        {
                            if (k == null) continue;
                            var path = k.GetValue("ExecutablePath") as string;
                            if (path != null && path.EndsWith("\\TaskosphereTray.exe", StringComparison.OrdinalIgnoreCase)
                                && k.GetValue("IsPromoted") == null)
                            {
                                k.SetValue("IsPromoted", 1, RegistryValueKind.DWord);
                            }
                        }
                    }
                }
            }
            catch { }
        }

        static string Call(string method, string path, string body)
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + path);
            req.Method = method;
            req.Proxy = null;
            req.Timeout = 3000;
            req.Headers.Add("X-Tray-Key", key);
            if (body != null)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(body);
                req.ContentType = "application/json";
                req.ContentLength = bytes.Length;
                using (var stream = req.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            }
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var reader = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
            {
                return reader.ReadToEnd();
            }
        }

        static void Send(string cmd)
        {
            try { Call("POST", "/tray/command", "{\"cmd\":\"" + cmd + "\"}"); } catch { }
        }

        static Dictionary<string, string> Parse(string text)
        {
            var result = new Dictionary<string, string>();
            foreach (string line in text.Split('\n'))
            {
                int tab = line.IndexOf('\t');
                if (tab > 0) result[line.Substring(0, tab)] = line.Substring(tab + 1).TrimEnd('\r');
            }
            return result;
        }

        static string Get(Dictionary<string, string> s, string k, string fallback)
        {
            string v;
            return s.TryGetValue(k, out v) && v.Length > 0 ? v : fallback;
        }
    }
}
