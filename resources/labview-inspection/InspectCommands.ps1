param([Parameter(Mandatory=$true)][string]$RequestFile, [Parameter(Mandatory=$true)][string]$ResponseFile)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Bordeaux's inspection adapter uses NI's installed COM API. It never executes
# team VIs or accesses remote target instances. The separate wrapper request runs
# only Bordeaux's local scripting helper and saves a new, caller-owned temporary VI.
Add-Type @'
using System;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Diagnostics;
using System.Security.Principal;
public static class BordeauxNiInspection {
  [DllImport("advapi32.dll", SetLastError = true)] private static extern bool OpenProcessToken(IntPtr process, UInt32 access, out IntPtr token);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
  public static string ProcessOwnerSid(int id) {
    using (Process process = Process.GetProcessById(id)) {
      IntPtr token;
      if (!OpenProcessToken(process.Handle, 8, out token)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      try { using (WindowsIdentity identity = new WindowsIdentity(token)) return identity.User.Value; }
      finally { CloseHandle(token); }
    }
  }
  public static object BindExisting() { return Activator.CreateInstance(Type.GetTypeFromProgID("LabVIEW.Application", true)); }
  public static object Get(object o, string n) { return o.GetType().InvokeMember(n, BindingFlags.GetProperty, null, o, null); }
  public static object Call(object o, string n, object[] args) { return o.GetType().InvokeMember(n, BindingFlags.InvokeMethod, null, o, args); }
  public static object[] Connector(object o) {
    object[] args = { null, (sbyte)0, null, null, null, null, null, null, null, null };
    ParameterModifier modifier = new ParameterModifier(args.Length);
    for (int i = 0; i < args.Length; i++) modifier[i] = true;
    o.GetType().InvokeMember("_ExportInterface2", BindingFlags.InvokeMethod, null, o, args, new ParameterModifier[] { modifier }, null, null);
    return args;
  }
  public static void Release(object o) { if (o != null && Marshal.IsComObject(o)) Marshal.ReleaseComObject(o); }
}
'@
function Assert-LocalFile([string]$File) {
  if (!$File -or $File.StartsWith('\\') -or $File.StartsWith('//')) { throw 'Inspection requires a local file.' }
  $full = [IO.Path]::GetFullPath($File)
  $current = Get-Item -LiteralPath $full -Force
  if ($current.PSIsContainer) { throw 'Inspection source must be a file.' }
  if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Inspection does not follow links or junctions.' }
  $current = $current.Directory
  while ($null -ne $current) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Inspection does not follow links or junctions.' }
    $current = $current.Parent
    if ($null -eq $current) { break }
  }
  return $full
}
function Read-Modified($VI) {
  try {
    foreach ($property in @('VIModificationBitSet', 'FPModificationBitSet', 'BDModificationBitSet')) {
      if ([uint32][BordeauxNiInspection]::Get($VI, $property) -ne 0) { return $true }
    }
    return $false
  } catch { return $null }
}
$app = $null
$context = $null
try {
  $request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
  if ($request.schemaVersion -notin @('bordeaux-ni-inspection/1', 'bordeaux-ni-wrapper/1') -or @($request.sources).Count -gt 1000) { throw 'Invalid Bordeaux NI request.' }
  $projectFile = Assert-LocalFile ([string]$request.projectFile)
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $registryView = if ([IntPtr]::Size -eq 4) { [Microsoft.Win32.RegistryView]::Registry32 } else { [Microsoft.Win32.RegistryView]::Registry64 }
  $registry = [Microsoft.Win32.RegistryKey]::OpenBaseKey('ClassesRoot', $registryView)
  try {
    $classKey = $registry.OpenSubKey('LabVIEW.Application\CLSID')
    if ($null -eq $classKey) { throw 'LabVIEW COM is not installed for this architecture.' }
    try { $clsid = [string]$classKey.GetValue('') } finally { $classKey.Dispose() }
    $serverKey = $registry.OpenSubKey("CLSID\$clsid\LocalServer32")
    if ($null -eq $serverKey) { throw 'LabVIEW COM server is not registered.' }
    try { $server = [string]$serverKey.GetValue('') } finally { $serverKey.Dispose() }
  } finally { $registry.Dispose() }
  $executable = $server.Replace(' /Automation', '').Trim('"')
  $processes = @(Get-Process -Name LabVIEW -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session -and $_.Path -eq $executable })
  if ($processes.Count -ne 1) { throw 'Open the selected project in one LabVIEW instance in this desktop session, then inspect again.' }
  $expected = $processes[0]
  if ([BordeauxNiInspection]::ProcessOwnerSid($expected.Id) -ne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'LabVIEW belongs to another Windows user. Inspection must run in the same user desktop as LabVIEW.' }
  $expected.Refresh()
  if ($expected.HasExited) { throw 'LabVIEW exited before inspection.' }
  $app = [BordeauxNiInspection]::BindExisting()
  if ([int][BordeauxNiInspection]::Get($app, '_ProcessID') -ne $expected.Id) { throw 'LabVIEW COM attached to a different process; inspection stopped.' }
  if ([string][BordeauxNiInspection]::Get($app, 'Version') -ne '25.3.3f3') { throw 'This Bordeaux NI connector adapter supports LabVIEW 2025 25.3.3f3. Use a declared or previously cached catalog for this NI version.' }
  foreach ($project in @([BordeauxNiInspection]::Get($app, 'AllProjects'))) {
    if ($null -eq $project) { continue }
    try {
      if ([IO.Path]::GetFullPath([string][BordeauxNiInspection]::Get($project, 'Path')) -eq $projectFile) {
        $context = [BordeauxNiInspection]::Get($project, 'Application')
        break
      }
    } finally { [BordeauxNiInspection]::Release($project) }
  }
  if ($null -eq $context) { throw 'The selected project is not already open in LabVIEW. Open it, then inspect again.' }
  if ($request.schemaVersion -eq 'bordeaux-ni-wrapper/1') {
    $commandFile = Assert-LocalFile ([string]$request.commandFile)
    $wrapperFile = [IO.Path]::GetFullPath([string]$request.wrapperFile)
    if ([IO.Path]::GetDirectoryName($commandFile) -ne [IO.Path]::GetDirectoryName($wrapperFile) -or [IO.Path]::GetFileName($wrapperFile) -notmatch '^\.bordeaux-wrapper-[a-f0-9-]+\.vi$') { throw 'Wrapper output must be a Bordeaux temporary VI alongside the command.' }
    if (Test-Path -LiteralPath $wrapperFile) { throw 'The temporary wrapper already exists.' }
    $helper = Assert-LocalFile (Join-Path $PSScriptRoot 'CreateCommandWrapper.vi')
    $generator = $null
    try {
      $generator = [BordeauxNiInspection]::Call($context, 'GetVIReference', @([string]$helper, [string]'', $false, 32))
      [void][BordeauxNiInspection]::Call($generator, 'SetControlValue', @('command path', $commandFile))
      [void][BordeauxNiInspection]::Call($generator, 'SetControlValue', @('wrapper path', $wrapperFile))
      [void][BordeauxNiInspection]::Call($generator, 'SetControlValue', @('terminal numbers', [double[]]@($request.terminalNumbers)))
      [void][BordeauxNiInspection]::Call($generator, 'Run', @($false))
      $failure = [BordeauxNiInspection]::Call($generator, 'GetControlValue', @('error out'))
      $terminalErrors = @([BordeauxNiInspection]::Call($generator, 'GetControlValue', @('terminal errors')))
      if ($failure[0]) { throw ('Wrapper scripting failed: ' + $failure[1] + ' ' + $failure[2]) }
      if ($terminalErrors.Count -ne [int]$request.terminalCount) { throw 'Wrapper terminal count does not match the inspected command. Rescan command inputs.' }
      foreach ($failure in $terminalErrors) { if ($failure[0]) { throw ('Wrapper terminal wiring failed: ' + $failure[1] + ' ' + $failure[2]) } }
      [void](Assert-LocalFile $wrapperFile)
      $response = @{ schemaVersion = 'bordeaux-ni-wrapper/1'; wrapperFile = $wrapperFile; terminalCount = $terminalErrors.Count }
      [IO.File]::WriteAllText($ResponseFile, ($response | ConvertTo-Json -Depth 8 -Compress), (New-Object Text.UTF8Encoding($false)))
    } finally { [BordeauxNiInspection]::Release($generator) }
    exit 0
  }
  $rows = @()
  foreach ($source in @($request.sources)) {
    $vi = $null
    $row = @{ file = [string]$source.file; target = [string]$source.target; status = 'unsupported' }
    try {
      $file = Assert-LocalFile ([string]$source.path)
      if ([IO.Path]::GetExtension($file) -ne '.vi') { throw 'Only saved VI source files can be inspected.' }
      # Suppress load-progress and missing-VI prompts; no reservation for execution.
      $vi = [BordeauxNiInspection]::Call($context, 'GetVIReference', @([string]$file, [string]'', $false, 32))
      if ([IO.Path]::GetFullPath([string][BordeauxNiInspection]::Get($vi, 'Path')) -ne $file) { throw 'NI returned a different VI path.' }
      $row.modifiedBefore = Read-Modified $vi
      $row.viType = [int][BordeauxNiInspection]::Get($vi, 'VIType')
      # Installed NI VITypeEnum: global VIs (3) have no callable connector.
      if ($row.viType -eq 3) {
        $row.modifiedAfter = Read-Modified $vi
        $row.status = 'nonCommand'
        $rows += @($row)
        continue
      }
      $row.name = [string][BordeauxNiInspection]::Get($vi, 'Name')
      $row.description = [string][BordeauxNiInspection]::Get($vi, 'Description')
      $row.execState = [int][BordeauxNiInspection]::Get($vi, 'ExecState')
      $connector = [BordeauxNiInspection]::Connector($vi)
      $row.connector = @{ numConnections = $connector[1]; captions = $connector[4]; wireRequirements = $connector[5]; ioStatus = $connector[6]; dataTypes = $connector[7]; conNum = $connector[8]; extendedInformation = $connector[9] }
      $row.defaults = @{}
      for ($index = 0; $index -lt [int]$connector[1]; $index++) {
        $typeXml = [string]$connector[7][$index]
        if ($connector[6][$index] -eq 0 -and $typeXml -match '^<(String|Boolean|DBL|SGL|I8|I16|I32|I64|U8|U16|U32|U64|EW|EB|EL)>') {
          try {
            # Canonical control labels come from type XML; help captions can differ.
            $label = ([xml]$typeXml).DocumentElement.SelectSingleNode('Name').InnerText
            $value = [BordeauxNiInspection]::Call($vi, '_GetCtrlDefaultValVariant', @([string]$label))
            # Keep JSON scalar defaults only; never serialize COM/refnum objects.
            if ($value -is [string] -or $value -is [bool] -or $value -is [byte] -or $value -is [sbyte] -or $value -is [int16] -or $value -is [uint16] -or $value -is [int32] -or $value -is [uint32] -or $value -is [single] -or $value -is [double]) { $row.defaults[$label] = $value }
            elseif ($value -is [int64] -or $value -is [uint64]) { $row.defaults[$label] = $value.ToString([Globalization.CultureInfo]::InvariantCulture) }
          } catch { }
        }
      }
      $row.modifiedAfter = Read-Modified $vi
      # The decoder validates every extendedInformation record and hashes all
      # root/nested typedef paths. Whole VI dependency traversal is unnecessary
      # for the connector contract and can load large unrelated hierarchies.
      $row.dependencies = @()
      $row.dependenciesAvailable = $true
      $row.status = 'inspected'
    } catch {
      $row.reason = $_.Exception.GetBaseException().Message
      if ($null -ne $vi) { $row.modifiedAfter = Read-Modified $vi }
    }
    finally { [BordeauxNiInspection]::Release($vi) }
    $rows += @($row)
  }
  $dirtyContext = $null
  try { $dirtyContext = @([BordeauxNiInspection]::Get($context, 'AllDirtyVIsAndLibs')).Count -gt 0 } catch { }
  $response = @{ schemaVersion = 'bordeaux-ni-inspection/1'; projectFile = $projectFile; inspectedAt = [DateTime]::UtcNow.ToString('o'); labviewVersion = [string][BordeauxNiInspection]::Get($app, 'Version'); dirtyContext = $dirtyContext; vis = $rows }
  [IO.File]::WriteAllText($ResponseFile, ($response | ConvertTo-Json -Depth 32 -Compress), (New-Object Text.UTF8Encoding($false)))
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
  exit 1
} finally {
  [BordeauxNiInspection]::Release($context)
  [BordeauxNiInspection]::Release($app)
}
