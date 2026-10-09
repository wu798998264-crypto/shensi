param(
  [switch]$Repair,
  [int]$ProcessId = 0,
  [string]$Executable = 'C:\Users\Administrator\AppData\Local\Programs\Shensi\Shensi.exe'
)
$ErrorActionPreference = 'Stop'
$resolvedExecutable = (Get-Item -LiteralPath $Executable).FullName
$windowProcesses = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($resolvedExecutable)) -ErrorAction SilentlyContinue | Where-Object {
  $_.MainWindowHandle -ne 0 -and $_.Path -eq $resolvedExecutable -and ($ProcessId -eq 0 -or $_.Id -eq $ProcessId)
})
if ($windowProcesses.Count -ne 1) { throw '需要唯一且路径经过核对的神思主窗口；未修改任何窗口。' }
$targetWindow = $windowProcesses[0]
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ShensiTaskbarIdentity {
 [StructLayout(LayoutKind.Sequential)] struct Key { public Guid fmtid; public uint pid; }
 [StructLayout(LayoutKind.Explicit,Size=24)] struct PV { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr ptr; }
 [ComImport,Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Store {
  [PreserveSig] int GetCount(out uint n); [PreserveSig] int GetAt(uint i,out Key k);
  [PreserveSig] int GetValue(ref Key k,out PV v); [PreserveSig] int SetValue(ref Key k,ref PV v);
 }
 [ComImport,Guid("de25675a-72de-44b4-9373-05170450c140"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Resolver {
  [PreserveSig] int GetAppIDForShortcut(IntPtr item,out IntPtr id);
  [PreserveSig] int GetAppIDForShortcutObject(IntPtr link,IntPtr item,out IntPtr id);
  [PreserveSig] int GetAppIDForWindow(IntPtr window,out IntPtr id,out int pinning,out int explicitId,out int embedded);
 }
 [DllImport("shell32.dll")] static extern int SHGetPropertyStoreForWindow(IntPtr h,ref Guid iid,[MarshalAs(UnmanagedType.Interface)] out Store store);
 [DllImport("ole32.dll")] static extern int PropVariantClear(ref PV v);
 static Key AppKey() { return new Key{fmtid=new Guid("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3"),pid=5}; }
 public static string Resolved(long hwnd) {
  object obj=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("660b90c8-73a9-4b58-8cae-355b7f55341b")));
  try { IntPtr id;int pin,exp,emb;int hr=((Resolver)obj).GetAppIDForWindow(new IntPtr(hwnd),out id,out pin,out exp,out emb);
   Marshal.ThrowExceptionForHR(hr);try{return id==IntPtr.Zero?"":Marshal.PtrToStringUni(id);}finally{if(id!=IntPtr.Zero)Marshal.FreeCoTaskMem(id);}
  } finally { Marshal.ReleaseComObject(obj); }
 }
 public static string Explicit(long hwnd) {
  Guid iid=new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");Store store;
  Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(hwnd),ref iid,out store));
  try { Key key=AppKey();PV v;Marshal.ThrowExceptionForHR(store.GetValue(ref key,out v));
   try{if(v.vt==0)return null;if(v.vt!=31)throw new InvalidOperationException("窗口标识不是预期字符串类型");return Marshal.PtrToStringUni(v.ptr);}finally{PropVariantClear(ref v);}
  } finally { Marshal.ReleaseComObject(store); }
 }
 public static void Bind(long hwnd,string appId) {
  Guid iid=new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");Store store;
  Marshal.ThrowExceptionForHR(SHGetPropertyStoreForWindow(new IntPtr(hwnd),ref iid,out store));
  try { Key key=AppKey();PV v=new PV();if(appId!=null){v.vt=31;v.ptr=Marshal.StringToCoTaskMemUni(appId);}
   try{Marshal.ThrowExceptionForHR(store.SetValue(ref key,ref v));}finally{PropVariantClear(ref v);}
  } finally { Marshal.ReleaseComObject(store); }
 }
}
'@
$hwnd = $targetWindow.MainWindowHandle.ToInt64()
$beforeResolved = [ShensiTaskbarIdentity]::Resolved($hwnd)
$beforeExplicit = [ShensiTaskbarIdentity]::Explicit($hwnd)
if ($Repair) {
  try {
    [ShensiTaskbarIdentity]::Bind($hwnd, 'com.shensi.creativeengine')
    if ([ShensiTaskbarIdentity]::Resolved($hwnd) -ne 'com.shensi.creativeengine') { throw '窗口绑定后 Shell 识别仍不匹配。' }
  } catch {
    [ShensiTaskbarIdentity]::Bind($hwnd, $beforeExplicit)
    throw
  }
}
[ordered]@{
  processId=$targetWindow.Id; hwnd=$hwnd; repaired=[bool]$Repair
  beforeResolved=$beforeResolved; beforeExplicit=$beforeExplicit
  afterResolved=[ShensiTaskbarIdentity]::Resolved($hwnd)
  afterExplicit=[ShensiTaskbarIdentity]::Explicit($hwnd)
} | ConvertTo-Json -Compress
