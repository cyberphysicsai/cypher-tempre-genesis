// Compile using the .NET Framework compiler; source and payload are embedded by build_windows.py.
// No elevation, registry, service, PATH modification, shell script, or remote command is used.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Text;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using File = CypherTempreInstaller.LongFile;
using Directory = CypherTempreInstaller.LongDirectory;
using FileStream = CypherTempreInstaller.LongFileStream;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName=".NET Framework 4.8")]

namespace CypherTempreInstaller {
  // Extended paths support dependency extraction without changing machine settings.
  // The upstream runtime's temporary-directory calls still need a bounded install root.
  static class LongPaths {
    public static string Extend(string value) {
      if(value == null || value.StartsWith("\\\\?\\",StringComparison.Ordinal)) return value;
      string absolute=Path.GetFullPath(value);
      return absolute.StartsWith("\\\\",StringComparison.Ordinal)?"\\\\?\\UNC\\"+absolute.Substring(2):"\\\\?\\"+absolute;
    }
  }
  sealed class LongFileStream : System.IO.FileStream {
    public LongFileStream(string path,FileMode mode,FileAccess access,FileShare share):base(LongPaths.Extend(path),mode,access,share) {}
  }
  static class LongFile {
    public static bool Exists(string path) {return System.IO.File.Exists(LongPaths.Extend(path));}
    public static FileAttributes GetAttributes(string path) {return System.IO.File.GetAttributes(LongPaths.Extend(path));}
    public static LongFileStream OpenRead(string path) {return new LongFileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read);}
    public static string ReadAllText(string path) {return System.IO.File.ReadAllText(LongPaths.Extend(path));}
    public static void WriteAllText(string path,string text) {System.IO.File.WriteAllText(LongPaths.Extend(path),text);}
    public static void WriteAllText(string path,string text,Encoding encoding) {System.IO.File.WriteAllText(LongPaths.Extend(path),text,encoding);}
    public static void AppendAllText(string path,string text) {System.IO.File.AppendAllText(LongPaths.Extend(path),text);}
    public static void WriteAllBytes(string path,byte[] bytes) {System.IO.File.WriteAllBytes(LongPaths.Extend(path),bytes);}
    public static void Delete(string path) {System.IO.File.Delete(LongPaths.Extend(path));}
    public static void Move(string source,string target) {System.IO.File.Move(LongPaths.Extend(source),LongPaths.Extend(target));}
    public static void Copy(string source,string target,bool overwrite) {System.IO.File.Copy(LongPaths.Extend(source),LongPaths.Extend(target),overwrite);}
    public static void Replace(string source,string target,string backup) {System.IO.File.Replace(LongPaths.Extend(source),LongPaths.Extend(target),LongPaths.Extend(backup));}
  }
  static class LongDirectory {
    public static bool Exists(string path) {return System.IO.Directory.Exists(LongPaths.Extend(path));}
    public static void CreateDirectory(string path) {System.IO.Directory.CreateDirectory(LongPaths.Extend(path));}
    public static IEnumerable<string> EnumerateFileSystemEntries(string path) {return System.IO.Directory.EnumerateFileSystemEntries(LongPaths.Extend(path));}
    public static void Move(string source,string target) {System.IO.Directory.Move(LongPaths.Extend(source),LongPaths.Extend(target));}
    public static void Delete(string path,bool recursive) {System.IO.Directory.Delete(LongPaths.Extend(path),recursive);}
  }
  public sealed class RuntimePin {
    public string version, url, sha256, prefix;
  }
  public sealed class Manifest {
    public string product, version, payloadSha256, payloadPrefix, openclawVersion;
    public Dictionary<string,string> dependencyOverrides;
    public RuntimePin node, python;
  }
  public sealed class ActiveRelease {
    public string product, version, release, node, python, data, payloadSha256;
  }
  public sealed class Options {
    public string root, cache, resultFile;
    public bool quiet, noLaunch, noShortcuts, launch, rollback, selfTest;
    public static Options Parse(string[] args) {
      Options value = new Options();
      value.root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CypherTempre", "ChainChat");
      for (int i = 0; i < args.Length; i++) {
        switch(args[i]) {
          case "--install-root": value.root = Next(args, ref i); break;
          case "--cache-dir": value.cache = Next(args, ref i); break;
          case "--result-file": value.resultFile = Next(args, ref i); break;
          case "--quiet": value.quiet = true; break;
          case "--no-launch": value.noLaunch = true; break;
          case "--no-shortcuts": value.noShortcuts = true; break;
          case "--launch": value.launch = true; break;
          case "--rollback": value.rollback = true; break;
          case "--self-test": value.selfTest = true; break;
          default: throw new InvalidOperationException("Unknown installer argument: " + args[i]);
        }
      }
      value.root = Installer.ValidateRoot(value.root);
      return value;
    }
    static string Next(string[] args, ref int index) {
      if (++index >= args.Length || String.IsNullOrWhiteSpace(args[index])) throw new InvalidOperationException("An installer argument is missing its value.");
      return args[index];
    }
  }
  public sealed class InstallForm : Form {
    readonly Label heading = new Label();
    readonly TextBox log = new TextBox();
    readonly ProgressBar progress = new ProgressBar();
    readonly Button finish = new Button();
    readonly PrivateFontCollection fonts = new PrivateFontCollection();
    IntPtr fontMemory = IntPtr.Zero;
    readonly Options options;
    public InstallForm(Options value) {
      options = value;
      Text = "Cypher Tempre ChainChat Setup";
      Width = 720; Height = 480; MinimumSize = new Size(540, 360);
      BackColor = Color.Black; ForeColor = Color.White;
      using(Stream source=Assembly.GetExecutingAssembly().GetManifestResourceStream("font.ttf")) {
        if(source != null) using(MemoryStream buffer=new MemoryStream()) {
          source.CopyTo(buffer); byte[] bytes=buffer.ToArray(); fontMemory=Marshal.AllocCoTaskMem(bytes.Length);
          Marshal.Copy(bytes,0,fontMemory,bytes.Length); fonts.AddMemoryFont(fontMemory,bytes.Length);
          Font=new Font(fonts.Families[0],9);
        }
      }
      StartPosition = FormStartPosition.CenterScreen;
      heading.Text = "CYPHER TEMPRE CHAINCHAT\r\nInstalling your local OpenClaw runtime";
      heading.SetBounds(24, 20, 660, 55); heading.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
      log.Multiline = true; log.ReadOnly = true; log.ScrollBars = ScrollBars.Vertical;
      log.BackColor = Color.FromArgb(18,18,18); log.ForeColor = Color.White;
      log.SetBounds(24, 88, 655, 260); log.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
      progress.Style = ProgressBarStyle.Marquee; progress.SetBounds(24, 365, 655, 16);
      progress.Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
      finish.Text = "Installing..."; finish.Enabled = false; finish.SetBounds(520, 395, 160, 30);
      finish.Anchor = AnchorStyles.Bottom | AnchorStyles.Right; finish.Click += delegate { Close(); };
      Controls.AddRange(new Control[] {heading, log, progress, finish});
      Shown += async delegate { await Run(); };
      FormClosing += delegate(object sender, FormClosingEventArgs e) { if(!finish.Enabled) e.Cancel=true; };
    }
    protected override void Dispose(bool disposing) {
      base.Dispose(disposing);
      if(disposing) { fonts.Dispose(); if(fontMemory != IntPtr.Zero) {Marshal.FreeCoTaskMem(fontMemory);fontMemory=IntPtr.Zero;} }
    }
    async Task Run() {
      try {
        await Task.Run(delegate { Installer.Execute(options, AddLog); });
        heading.Text = "CYPHER TEMPRE CHAINCHAT\r\nInstallation complete";
        progress.Style = ProgressBarStyle.Continuous; progress.Value = 100;
        finish.Text = "Close"; finish.Enabled = true;
      } catch (Exception error) {
        Installer.RecordResult(options, false, error.Message);
        AddLog("Installation held: " + error.Message);
        heading.Text = "CYPHER TEMPRE CHAINCHAT\r\nSetup needs attention";
        progress.Style = ProgressBarStyle.Continuous;
        finish.Text = "Close"; finish.Enabled = true;
        Environment.ExitCode = 1;
      }
    }
    void AddLog(string message) {
      if (InvokeRequired) { BeginInvoke((Action<string>)AddLog, message); return; }
      log.AppendText(message + Environment.NewLine);
    }
  }
  public static class Installer {
    const string Product = "cypher-tempre-chainchat";
    const long MaxArchiveBytes = 1024L * 1024 * 1024;
    const long MaxExpandedBytes = 4L * 1024 * 1024 * 1024;
    const int MaxRootPathLength = 120;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static Action<string> Write = delegate {};
    static string installLog;

    public static string ValidateRoot(string raw) {
      if (String.IsNullOrWhiteSpace(raw) || raw.Length < 3 || !Char.IsLetter(raw[0]) || raw[1] != ':' || (raw[2] != '\\' && raw[2] != '/') || raw.StartsWith("\\\\")) throw new InvalidOperationException("Choose an absolute local installation directory.");
      string root = Path.GetFullPath(raw).TrimEnd(Path.DirectorySeparatorChar);
      if (root.Length < 8 || root.Equals(Path.GetPathRoot(root).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The installation directory cannot be a drive root.");
      if (root.Length > MaxRootPathLength) throw new InvalidOperationException("The upstream OpenClaw Windows temporary-path limit requires an installation directory of 120 characters or fewer. Choose a shorter location, such as the default %LOCALAPPDATA%\\CypherTempre\\ChainChat.");
      foreach (Environment.SpecialFolder special in new [] {Environment.SpecialFolder.Windows, Environment.SpecialFolder.ProgramFiles, Environment.SpecialFolder.ProgramFilesX86, Environment.SpecialFolder.UserProfile}) {
        string protectedPath = Environment.GetFolderPath(special);
        if (!String.IsNullOrEmpty(protectedPath) && (root.Equals(protectedPath.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) ||
             (special != Environment.SpecialFolder.UserProfile && root.StartsWith(protectedPath.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)))) throw new InvalidOperationException("Choose a dedicated per-user ChainChat directory.");
      }
      RejectLinks(root);
      return root;
    }
    static void RejectLinks(string path) {
      string current = Path.GetFullPath(path);
      while (!String.IsNullOrEmpty(current)) {
        if ((File.Exists(current) || Directory.Exists(current)) && (File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new InvalidOperationException("Installation paths may not traverse symbolic links or junctions.");
        current = Path.GetDirectoryName(current);
      }
    }
    static string Child(string root, string relative) {
      string prefix = Path.GetFullPath(root).TrimEnd('\\') + "\\";
      string result = Path.GetFullPath(Path.Combine(root, relative));
      if (!result.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("An archive or release path escapes its installation directory.");
      RejectLinks(result);
      return result;
    }
    public static string ArchivePath(string root, string name, string prefix) {
      name = name.Replace('\\', '/');
      if (name.StartsWith("/") || name.Contains(":")) throw new InvalidOperationException("Unsafe rooted archive path.");
      if (!String.IsNullOrEmpty(prefix)) {
        if (!name.StartsWith(prefix, StringComparison.Ordinal)) throw new InvalidOperationException("Archive has an unexpected root directory.");
        name = name.Substring(prefix.Length);
      }
      if (name.Length == 0) return null;
      foreach (string part in name.Split('/')) {
        if (part.Length == 0 && name.EndsWith("/")) continue;
        if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(" ") || part.EndsWith(".") || part.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) throw new InvalidOperationException("Unsafe archive member name.");
        string device = part.Split('.')[0].ToUpperInvariant();
        if (new [] {"CON","PRN","AUX","NUL","COM1","COM2","COM3","COM4","COM5","COM6","COM7","COM8","COM9","LPT1","LPT2","LPT3","LPT4","LPT5","LPT6","LPT7","LPT8","LPT9"}.Contains(device)) throw new InvalidOperationException("Reserved Windows archive member name.");
      }
      return Child(root, name.Replace('/', '\\'));
    }
    static string Sha256(string file) {
      using (FileStream source = File.OpenRead(file)) using (SHA256 algorithm = SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(source)).Replace("-", "").ToLowerInvariant();
    }
    static string Sha256Bytes(byte[] bytes) {
      using (SHA256 algorithm = SHA256.Create()) return BitConverter.ToString(algorithm.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
    }
    static byte[] Resource(string name) {
      using (Stream source = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)) {
        if (source == null) throw new InvalidOperationException("Installer resource is missing: " + name);
        using (MemoryStream target = new MemoryStream()) { source.CopyTo(target); return target.ToArray(); }
      }
    }
    static void AtomicJson(string file, object value) {
      Directory.CreateDirectory(Path.GetDirectoryName(file)); RejectLinks(file);
      string temp = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
      byte[] data = Encoding.UTF8.GetBytes(Json.Serialize(value));
      using (FileStream stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { stream.Write(data, 0, data.Length); stream.Flush(true); }
      if (File.Exists(file)) File.Replace(temp, file, null); else File.Move(temp, file);
    }
    static void Download(RuntimePin pin, string destination, string cache) {
      if (File.Exists(destination) && Sha256(destination) == pin.sha256) return;
      if (!String.IsNullOrEmpty(cache)) {
        string cached = Path.Combine(Path.GetFullPath(cache), Path.GetFileName(new Uri(pin.url).AbsolutePath));
        if (File.Exists(cached) && Sha256(cached) == pin.sha256) { File.Copy(cached, destination, true); return; }
      }
      string temporary = destination + ".download";
      Uri uri = new Uri(pin.url);
      ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
      for (int redirects = 0; redirects <= 5; redirects++) {
        if (uri.Scheme != "https" || (uri.Host != "nodejs.org" && uri.Host != "www.python.org")) throw new InvalidOperationException("Runtime download must use a pinned official HTTPS host.");
        HttpWebRequest request = (HttpWebRequest)WebRequest.Create(uri); request.AllowAutoRedirect = false; request.Timeout = 120000;
        using (HttpWebResponse response = (HttpWebResponse)request.GetResponse()) {
          if ((int)response.StatusCode >= 300 && (int)response.StatusCode < 400) { uri = new Uri(uri, response.Headers["Location"]); continue; }
          if (response.StatusCode != HttpStatusCode.OK) throw new InvalidOperationException("Runtime download returned an unexpected response.");
          using (Stream input = response.GetResponseStream()) using (FileStream output = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None)) {
            byte[] buffer = new byte[65536]; int count; long total = 0;
            while ((count = input.Read(buffer, 0, buffer.Length)) > 0) { total += count; if (total > MaxArchiveBytes) throw new InvalidOperationException("Runtime download exceeded its size limit."); output.Write(buffer, 0, count); }
            output.Flush(true);
          }
          if (Sha256(temporary) != pin.sha256) throw new InvalidOperationException("Runtime SHA-256 mismatch. Nothing was executed.");
          if (File.Exists(destination)) File.Delete(destination); File.Move(temporary, destination); return;
        }
      }
      throw new InvalidOperationException("Too many runtime download redirects.");
    }
    static void Extract(string archive, string target, string prefix) {
      Directory.CreateDirectory(target); RejectLinks(target);
      using (ZipArchive zip = ZipFile.OpenRead(LongPaths.Extend(archive))) {
        long expanded = 0; int count = 0; HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (ZipArchiveEntry entry in zip.Entries) {
          if (++count > 100000 || (expanded += entry.Length) > MaxExpandedBytes || ((entry.ExternalAttributes >> 16) & 0xF000) == 0xA000) throw new InvalidOperationException("Archive exceeds limits or contains symbolic links.");
          string path = ArchivePath(target, entry.FullName, prefix); if (path == null) continue;
          if (!seen.Add(path)) throw new InvalidOperationException("Archive contains duplicate Windows paths.");
          if (entry.FullName.EndsWith("/")) { Directory.CreateDirectory(path); continue; }
          Directory.CreateDirectory(Path.GetDirectoryName(path));
          using (Stream input = entry.Open()) using (FileStream output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
            byte[] buffer=new byte[65536]; int read; long copied=0;
            while((read=input.Read(buffer,0,buffer.Length)) > 0) { copied+=read; if(copied>entry.Length || copied>MaxExpandedBytes) throw new InvalidOperationException("Archive data exceeds its declared size."); output.Write(buffer,0,read); }
            if(copied != entry.Length) throw new InvalidOperationException("Archive data is truncated."); output.Flush(true);
          }
        }
      }
    }
    static void VerifyArchiveFiles(string archive, string target, string prefix, HashSet<string> except) {
      using (ZipArchive zip = ZipFile.OpenRead(LongPaths.Extend(archive))) foreach (ZipArchiveEntry entry in zip.Entries) {
        if (entry.FullName.EndsWith("/")) continue;
        string path = ArchivePath(target, entry.FullName, prefix); if (path == null || (except != null && except.Contains(Path.GetFileName(path)))) continue;
        if (!File.Exists(path)) throw new InvalidOperationException("An installed runtime or application file is missing.");
        byte[] expected; using (Stream input = entry.Open()) using (MemoryStream buffer = new MemoryStream()) { input.CopyTo(buffer); expected = buffer.ToArray(); }
        if (Sha256(path) != Sha256Bytes(expected)) throw new InvalidOperationException("An installed runtime or application file has changed: " + Path.GetFileName(path));
      }
    }
    static Dictionary<string,string> EnvironmentFor(ActiveRelease release, string installRoot) {
      return new Dictionary<string,string> { {"CT_CHAT_NODE", release.node}, {"CT_CHAT_PYTHON", release.python}, {"CT_CHAT_DATA", release.data},
        {"CT_OPERATOR_TRUST_ROOT", Path.Combine(release.data,"operator-approvals")},
        {"CT_OPENCLAW_MODULE", Path.Combine(release.release, "openclaw", "runtime", "node_modules", "openclaw")},
        {"PYTHONIOENCODING", "utf-8"}, {"PYTHONUTF8", "1"}, {"PYTHONDONTWRITEBYTECODE", "1"},
        {"npm_config_cache", Path.Combine(installRoot, "cache", "npm")}, {"npm_config_audit", "false"}, {"npm_config_fund", "false"},
        {"PATH", Path.GetDirectoryName(release.node) + ";" + Environment.GetEnvironmentVariable("PATH")} };
    }
    static string Quote(string value) {
      // Windows CommandLineToArgvW escaping, including trailing backslashes.
      StringBuilder quoted = new StringBuilder("\""); int slashes = 0;
      foreach(char c in value) { if(c == '\\') { slashes++; continue; } if(c == '"') { quoted.Append('\\', slashes * 2 + 1); quoted.Append(c); slashes = 0; continue; } quoted.Append('\\', slashes); slashes=0; quoted.Append(c); }
      quoted.Append('\\', slashes * 2); return quoted.Append('"').ToString();
    }
    static void Run(string executable, string[] arguments, string directory, Dictionary<string,string> environment, int timeoutSeconds) {
      ProcessStartInfo info = new ProcessStartInfo(executable, String.Join(" ", arguments.Select(Quote))) { WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
      foreach (KeyValuePair<string,string> item in environment) info.EnvironmentVariables[item.Key] = item.Value;
      using (Process child = new Process()) {
        child.StartInfo = info; child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { if(e.Data != null) Log(e.Data); };
        child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) { if(e.Data != null) Log(e.Data); };
        child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine();
        if (!child.WaitForExit(timeoutSeconds * 1000)) { try { child.Kill(); } catch {} throw new InvalidOperationException("Dependency installation or runtime check timed out; the current release remains selected."); }
        child.WaitForExit(); if(child.ExitCode != 0) throw new InvalidOperationException("Dependency installation or runtime check failed; see install.log.");
      }
    }
    static void Log(string message) { lock(typeof(Installer)) { Write(message); if(installLog != null) File.AppendAllText(installLog, DateTime.UtcNow.ToString("o") + " " + message + Environment.NewLine); } }
    static void ValidateRelease(ActiveRelease active, string root) {
      if(active == null || active.product != Product || !active.release.StartsWith(Path.Combine(root,"releases") + "\\", StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The selected release pointer is invalid.");
      foreach(string path in new[]{active.release,active.node,active.python}) {
        if(String.IsNullOrEmpty(path) || !Path.GetFullPath(path).StartsWith(root.TrimEnd('\\')+"\\",StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("A release path is outside the installation.");
        Child(root,path.Substring(root.Length+1));
      }
      if(!File.Exists(active.node) || !File.Exists(active.python) || !File.Exists(Path.Combine(active.release,"openclaw","launcher.mjs"))) throw new InvalidOperationException("The selected release is incomplete. Re-run the verified installer.");
      if(!String.Equals(active.data, Path.Combine(root,"data"), StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("The selected data directory is invalid.");
    }
    static ActiveRelease ReadRelease(string file, string root) {
      RejectLinks(file); ActiveRelease active = Json.Deserialize<ActiveRelease>(File.ReadAllText(file)); ValidateRelease(active, root); return active;
    }
    static bool OwnedRuntimeReady(ActiveRelease active,out int ownerPid) {
      ownerPid=0;
      try {
        string ownerFile=Child(active.data,"runtime-owner.json");
        if(!File.Exists(ownerFile) || new FileInfo(LongPaths.Extend(ownerFile)).Length>16384) return false;
        Dictionary<string,object> owner=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(ownerFile));
        int port=Convert.ToInt32(owner["port"]),pid=Convert.ToInt32(owner["pid"]);
        string token=Convert.ToString(owner["token"]),version=Convert.ToString(owner["version"]),appRoot=Convert.ToString(owner["appRoot"]);
        if(port<1 || port>65535 || pid<1 || token.Length!=64 || token.Any(c=>!((c>='0' && c<='9') || (c>='a' && c<='f'))) ||
            version!=active.version || !String.Equals(Path.GetFullPath(appRoot).TrimEnd('\\','/'),Path.GetFullPath(active.release).TrimEnd('\\','/'),StringComparison.OrdinalIgnoreCase)) return false;
        HttpWebRequest request=(HttpWebRequest)WebRequest.Create("http://127.0.0.1:"+port+"/status");
        request.Proxy=null; request.AllowAutoRedirect=false; request.Timeout=1500; request.ReadWriteTimeout=1500; request.KeepAlive=false;
        request.Headers[HttpRequestHeader.Authorization]="Bearer "+token;
        using(HttpWebResponse response=(HttpWebResponse)request.GetResponse()) {
          if(response.StatusCode!=HttpStatusCode.OK || response.ContentLength>8192) return false;
          using(StreamReader input=new StreamReader(response.GetResponseStream(),Encoding.UTF8)) {
            char[] buffer=new char[1024]; int read; StringBuilder body=new StringBuilder();
            while((read=input.Read(buffer,0,buffer.Length))>0) { if(body.Length+read>8192) return false; body.Append(buffer,0,read); }
            Dictionary<string,object> status=Json.Deserialize<Dictionary<string,object>>(body.ToString());
            bool ready=Convert.ToInt32(status["pid"])==pid && Convert.ToString(status["version"])==version;
            if(ready) ownerPid=pid; return ready;
          }
        }
      } catch { return false; } // A partial ownership write or starting control server is retried.
    }
    static void Launch(ActiveRelease active, string root) {
      ValidateRelease(active, root);
      ProcessStartInfo info = new ProcessStartInfo(active.node, Quote(Path.Combine(active.release,"openclaw","launcher.mjs"))) { WorkingDirectory = active.release, UseShellExecute = false, CreateNoWindow = true };
      foreach(KeyValuePair<string,string> item in EnvironmentFor(active, root)) info.EnvironmentVariables[item.Key] = item.Value;
      string failure="ChainChat could not start its local runtime. See "+Path.Combine(active.data,"launcher.log")+" for diagnostics. Check whether the local port is already in use, then open ChainChat again.";
      Process child;
      try { child=Process.Start(info); } catch { throw new InvalidOperationException(failure); }
      if(child==null) throw new InvalidOperationException(failure);
      Log("Waiting for the local ChainChat runtime to become ready");
      using(child) {
        Stopwatch deadline=Stopwatch.StartNew();
        while(deadline.Elapsed.TotalSeconds<120) {
          // This private control exists only after the local UI is listening.
          // Never log its token or request a new browser bootstrap nonce here.
          int ownerPid;
          if(OwnedRuntimeReady(active,out ownerPid) && ownerPid==child.Id) { Log("Local ChainChat runtime is ready"); return; }
          if(child.WaitForExit(200)) {
            if(child.ExitCode==0 && OwnedRuntimeReady(active,out ownerPid)) { Log("Local ChainChat runtime is ready"); return; }
            throw new InvalidOperationException(failure);
          }
        }
      }
      // Never kill an old bridge, an unrelated process, or pending native work.
      throw new InvalidOperationException(failure);
    }
    static void Shortcut(string target, string arguments, string root) {
      string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
      object shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
      string name=arguments.StartsWith("--rollback",StringComparison.Ordinal)?"Cypher Tempre ChainChat - Previous version.lnk":"Cypher Tempre ChainChat.lnk";
      object shortcut = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] {Path.Combine(programs,name)});
      Type type = shortcut.GetType();
      type.InvokeMember("TargetPath", BindingFlags.SetProperty, null, shortcut, new object[] {target});
      type.InvokeMember("Arguments", BindingFlags.SetProperty, null, shortcut, new object[] {arguments});
      type.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, shortcut, new object[] {root});
      type.InvokeMember("Description", BindingFlags.SetProperty, null, shortcut, new object[] {"Launch your local Cypher Tempre ChainChat agent"});
      type.InvokeMember("Save", BindingFlags.InvokeMethod, null, shortcut, null);
    }
    public static void Execute(Options options, Action<string> write) {
      Write = write;
      if(options.selfTest) { SelfTest(); RecordResult(options,true,"Installer self-tests passed."); return; }
      string root = options.root, activeFile = Path.Combine(root,"current.json"), previousFile = Path.Combine(root,"previous.json");
      if(options.launch) { Launch(ReadRelease(activeFile,root),root); RecordResult(options,true,"ChainChat local runtime is ready."); return; }
      if(options.rollback) {
        ActiveRelease previous = ReadRelease(previousFile,root); ActiveRelease current = ReadRelease(activeFile,root);
        if(!options.noLaunch) Run(current.node,new[]{Path.Combine(current.release,"openclaw","launcher.mjs"),"--stop"},current.release,EnvironmentFor(current,root),120);
        AtomicJson(previousFile,current); AtomicJson(activeFile,previous);
        if(!options.noLaunch) Launch(previous,root); RecordResult(options,true,"Previous release selected; chain data preserved."); return;
      }
      if(!Environment.Is64BitOperatingSystem) throw new InvalidOperationException("This installer requires 64-bit Windows.");
      string marker = Path.Combine(root,"installation.json");
      if(Directory.Exists(root) && Directory.EnumerateFileSystemEntries(root).Any() && !File.Exists(marker)) throw new InvalidOperationException("The target is not a recognized ChainChat installation. Choose a new dedicated directory.");
      Directory.CreateDirectory(root); RejectLinks(root);
      if(File.Exists(marker)) {
        RejectLinks(marker); Dictionary<string,object> identity = Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(marker));
        if(!identity.ContainsKey("product") || Convert.ToString(identity["product"]) != Product) throw new InvalidOperationException("The installation identity does not match ChainChat.");
      } else AtomicJson(marker,new {product=Product,format=1});
      installLog = Path.Combine(root,"install.log"); RejectLinks(installLog);
      using(FileStream installLock = new FileStream(Path.Combine(root,"install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)) {
        Manifest manifest = Json.Deserialize<Manifest>(Encoding.UTF8.GetString(Resource("manifest.json")));
        if(manifest.product != Product || String.IsNullOrEmpty(manifest.version)) throw new InvalidOperationException("Invalid embedded installation manifest.");
        string downloads = Path.Combine(root,"cache","downloads"); Directory.CreateDirectory(downloads); RejectLinks(downloads);
        string payload = Path.Combine(downloads,"app-"+manifest.payloadSha256+".zip");
        RejectLinks(payload);
        byte[] source = Resource("payload.zip");
        if(Sha256Bytes(source) != manifest.payloadSha256) throw new InvalidOperationException("Embedded application payload is damaged.");
        File.WriteAllBytes(payload,source);
        string nodeZip = Path.Combine(downloads,Path.GetFileName(new Uri(manifest.node.url).AbsolutePath));
        string pythonZip = Path.Combine(downloads,Path.GetFileName(new Uri(manifest.python.url).AbsolutePath));
        RejectLinks(nodeZip); RejectLinks(pythonZip);
        Log("Downloading and verifying Node.js " + manifest.node.version + " from nodejs.org"); Download(manifest.node,nodeZip,options.cache);
        Log("Downloading and verifying CPython " + manifest.python.version + " from python.org"); Download(manifest.python,pythonZip,options.cache);
        string node = Path.Combine(root,"runtimes","node-"+manifest.node.version+"-"+manifest.node.sha256.Substring(0,12));
        if(!Directory.Exists(node)) { string stage=node+".stage-"+Guid.NewGuid().ToString("N"); Extract(nodeZip,stage,manifest.node.prefix); Directory.Move(stage,node); }
        VerifyArchiveFiles(nodeZip,node,manifest.node.prefix,null);
        string release = Path.Combine(root,"releases",manifest.version+"-"+manifest.payloadSha256.Substring(0,12));
        ActiveRelease active = new ActiveRelease {product=Product,version=manifest.version,release=release,node=Path.Combine(node,"node.exe"),python=Path.Combine(release,".runtime","python","python.exe"),data=Path.Combine(root,"data"),payloadSha256=manifest.payloadSha256};
        if(!Directory.Exists(release)) {
          string stage=release+".stage-"+Guid.NewGuid().ToString("N"); Log("Staging ChainChat " + manifest.version); Extract(payload,stage,manifest.payloadPrefix);
          Extract(pythonZip,Path.Combine(stage,".runtime","python"),manifest.python.prefix);
          File.WriteAllText(Path.Combine(stage,".runtime","python","python312._pth"),"python312.zip\n.\n"+release+"\n"+Path.Combine(release,"engine","proof-of-interaction")+"\nimport site\n",new UTF8Encoding(false));
          Directory.CreateDirectory(Path.GetDirectoryName(release)); Directory.Move(stage,release);
        }
        VerifyArchiveFiles(payload,release,manifest.payloadPrefix,null);
        if(!File.Exists(Path.Combine(release,"installed.json"))) {
          Dictionary<string,string> environment=EnvironmentFor(active,root);
          string npm=Path.Combine(node,"node_modules","npm","bin","npm-cli.js");
          Log("Installing locked ChainChat dependencies (registry.npmjs.org)"); Run(active.node,new [] {npm,"ci","--omit=dev","--ignore-scripts"},release,environment,1800);
          Log("Installing pinned OpenClaw " + manifest.openclawVersion + " and locked dependencies"); Run(active.node,new [] {npm,"ci","--omit=dev","--ignore-scripts"},Path.Combine(release,"openclaw","runtime"),environment,2400);
          AtomicJson(Path.Combine(release,"installed.json"),new {product=Product,payloadSha256=manifest.payloadSha256,openclawVersion=manifest.openclawVersion});
        }
        VerifyArchiveFiles(pythonZip,Path.Combine(release,".runtime","python"),manifest.python.prefix,new HashSet<string>{"python312._pth"});
        string expectedPythonPath="python312.zip\n.\n"+release+"\n"+Path.Combine(release,"engine","proof-of-interaction")+"\nimport site\n";
        if(File.ReadAllText(Path.Combine(release,".runtime","python","python312._pth")) != expectedPythonPath) throw new InvalidOperationException("The embedded Python import path changed; reinstall the reviewed release.");
        string packageFile=Path.Combine(release,"openclaw","runtime","node_modules","openclaw","package.json");
        Dictionary<string,object> package=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(packageFile));
        if(Convert.ToString(package["version"]) != manifest.openclawVersion) throw new InvalidOperationException("Installed OpenClaw version differs from its pinned release.");
        if(manifest.dependencyOverrides != null) foreach(KeyValuePair<string,string> dependency in manifest.dependencyOverrides) {
          string dependencyFile=Child(Path.Combine(release,"openclaw","runtime","node_modules"),Path.Combine(dependency.Key,"package.json"));
          Dictionary<string,object> installedDependency=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(dependencyFile));
          if(Convert.ToString(installedDependency["name"]) != dependency.Key || Convert.ToString(installedDependency["version"]) != dependency.Value) throw new InvalidOperationException("An installed dependency differs from its pinned security override.");
        }
        if(!File.Exists(Path.Combine(release,"installed.json"))) throw new InvalidOperationException("The staged dependency installation is incomplete; preserve install.log and select a fresh installation root or retry a repaired release.");
        Log("Checking bundled Node, Python and ChainChat runtime");
        Run(active.node,new[]{"--version"},release,EnvironmentFor(active,root),30);
        Run(active.python,new[]{"-c","import sys,json,hashlib,pathlib,subprocess; import engine_bridge; print('Python and native engine ready')"},release,EnvironmentFor(active,root),30);
        Run(active.node,new[]{Path.Combine(release,"openclaw","launcher.mjs"),"--check"},release,EnvironmentFor(active,root),120);
        Directory.CreateDirectory(active.data);
        if(!options.noLaunch && File.Exists(activeFile)) {
          ActiveRelease current=ReadRelease(activeFile,root);
          Log("Stopping the previously installed ChainChat runtime through its authenticated local owner control");
          Run(current.node,new[]{Path.Combine(current.release,"openclaw","launcher.mjs"),"--stop"},current.release,EnvironmentFor(current,root),120);
        }
        if(File.Exists(activeFile)) AtomicJson(previousFile,ReadRelease(activeFile,root));
        AtomicJson(activeFile,active);
        string launcher=Path.Combine(root,"ChainChat.exe");
        if(!String.Equals(Assembly.GetExecutingAssembly().Location,launcher,StringComparison.OrdinalIgnoreCase)) File.Copy(Assembly.GetExecutingAssembly().Location,launcher,true);
        if(!options.noShortcuts) { Shortcut(launcher,"--launch --install-root "+Quote(root),root); if(File.Exists(previousFile)) Shortcut(launcher,"--rollback --install-root "+Quote(root),root); }
        Log("Installation complete. Existing data and external Timechain directories were preserved.");
        if(!options.noLaunch) { Log("Starting ChainChat"); Launch(active,root); }
        RecordResult(options,true,"ChainChat installed; existing data preserved.");
      }
    }
    public static void RecordResult(Options options, bool ok, string message) {
      if(String.IsNullOrEmpty(options.resultFile)) return;
      AtomicJson(Path.GetFullPath(options.resultFile),new {ok=ok,message=message,installRoot=options.root});
    }
    static void SelfTest() {
      string root=Path.Combine(Path.GetTempPath(),"ct-installer-selftest-"+Guid.NewGuid().ToString("N"));
      foreach(string bad in new[]{"../escape.txt","/escape.txt","C:/escape.txt","pkg/../../escape.txt","CON.txt","folder/../escape","name.","file:stream","folder//file"}) {
        bool refused=false; try { ArchivePath(root,bad,""); } catch(InvalidOperationException) {refused=true;} if(!refused) throw new Exception("Unsafe archive path was accepted.");
      }
      if(ArchivePath(root,"pkg/file.txt","pkg/") != Path.Combine(root,"file.txt")) throw new Exception("Valid archive path changed.");
      if(Sha256Bytes(Encoding.ASCII.GetBytes("abc")) != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") throw new Exception("Hash check failed.");
      bool relativeRefused=false; try {ValidateRoot("C:relative");} catch(InvalidOperationException) {relativeRefused=true;} if(!relativeRefused) throw new Exception("Drive-relative installation path was accepted.");
      string boundary=Path.GetPathRoot(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData))+new string('p',85)+Guid.NewGuid().ToString("N");
      bool boundaryExisted=Directory.Exists(boundary);
      if(boundary.Length != MaxRootPathLength || ValidateRoot(boundary) != boundary || Directory.Exists(boundary) != boundaryExisted) throw new Exception("The supported installation path boundary changed or validation wrote a directory.");
      string tooLong=boundary+"p"; bool tooLongExisted=Directory.Exists(tooLong),tooLongRefused=false;
      try {ValidateRoot(tooLong);} catch(InvalidOperationException error) {tooLongRefused=error.Message.Contains("temporary-path limit") && error.Message.Contains("shorter location");}
      if(!tooLongRefused || Directory.Exists(tooLong) != tooLongExisted) throw new Exception("An unsupported deep installation path was accepted or validation wrote a directory.");
      if(Assembly.GetExecutingAssembly().GetManifestResourceInfo("font.ttf") != null) using(InstallForm form=new InstallForm(new Options())) { if(form.Font.FontFamily.Name.IndexOf("Orbitron",StringComparison.OrdinalIgnoreCase) < 0) throw new Exception("Bundled Orbitron font did not load."); }
      Directory.CreateDirectory(root);
      try {
        string archive=Path.Combine(root,"fixture.zip"),target=Path.Combine(root,"expanded");
        using(ZipArchive zip=ZipFile.Open(archive,ZipArchiveMode.Create)) {
          using(StreamWriter output=new StreamWriter(zip.CreateEntry("nested/valid.txt").Open())) output.Write("verified fixture bytes");
        }
        Extract(archive,target,""); VerifyArchiveFiles(archive,target,"",null);
        string deep=Path.Combine(root,new string('a',100),new string('b',100),new string('c',100));
        Extract(archive,deep,""); VerifyArchiveFiles(archive,deep,"",null);
        File.AppendAllText(Path.Combine(target,"nested","valid.txt"),"changed");
        bool changed=false; try {VerifyArchiveFiles(archive,target,"",null);} catch(InvalidOperationException) {changed=true;} if(!changed) throw new Exception("Changed extracted bytes were accepted.");
        string duplicate=Path.Combine(root,"duplicates.zip");
        using(ZipArchive zip=ZipFile.Open(duplicate,ZipArchiveMode.Create)) { zip.CreateEntry("A.txt"); zip.CreateEntry("a.txt"); }
        bool duplicateRefused=false; try {Extract(duplicate,Path.Combine(root,"duplicates"),"");} catch(InvalidOperationException) {duplicateRefused=true;} if(!duplicateRefused) throw new Exception("Case-colliding archive entries were accepted.");
        string traversal=Path.Combine(root,"traversal.zip");
        using(ZipArchive zip=ZipFile.Open(traversal,ZipArchiveMode.Create)) zip.CreateEntry("../escape.txt");
        bool traversalRefused=false; try {Extract(traversal,Path.Combine(root,"traversal"),"");} catch(InvalidOperationException) {traversalRefused=true;} if(!traversalRefused || File.Exists(Path.Combine(root,"escape.txt"))) throw new Exception("Traversal archive wrote outside extraction root.");
        string atomic=Path.Combine(root,"atomic.json"); AtomicJson(atomic,new {value=1}); AtomicJson(atomic,new {value=2});
        if(!File.ReadAllText(atomic).Contains("\"value\":2")) throw new Exception("Atomic state replacement failed.");
      } finally {
        string full=Path.GetFullPath(root),temporary=Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\')+"\\";
        if(!full.StartsWith(temporary,StringComparison.OrdinalIgnoreCase) || !Path.GetFileName(full).StartsWith("ct-installer-selftest-",StringComparison.Ordinal)) throw new Exception("Temporary test cleanup root is invalid.");
        Directory.Delete(full,true);
      }
      Log("Installer path, prefix and checksum self-tests passed.");
    }
  }
  static class Program {
    [STAThread] static int Main(string[] args) {
      AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling",false);
      AppContext.SetSwitch("Switch.System.IO.BlockLongPaths",false);
      Options options=null;
      try {
        options=Options.Parse(args);
        if(options.quiet || options.launch || options.rollback || options.selfTest) { Installer.Execute(options,delegate{}); return 0; }
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new InstallForm(options)); return Environment.ExitCode;
      } catch(Exception error) {
        if(options != null) Installer.RecordResult(options,false,error.Message);
        if(options == null || !options.quiet) MessageBox.Show(error.Message,"Cypher Tempre ChainChat",MessageBoxButtons.OK,MessageBoxIcon.Error);
        return 1;
      }
    }
  }
}
