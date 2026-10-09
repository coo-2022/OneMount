// Fixture for a disposable Windows CI desktop. A normal interactive logon grants
// these desktop permissions automatically; CreateProcessWithLogonW does not.
// Preserve and restore the original ACLs. This does not elevate the test token.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;

public sealed class CiDesktopAccess : IDisposable {
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetThreadDesktop(uint tid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError=true)] static extern bool GetUserObjectSecurity(IntPtr handle, ref uint info, byte[] data, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetUserObjectSecurity(IntPtr handle, ref uint info, byte[] data);
    readonly IntPtr station, desktop;
    readonly byte[] oldStation, oldDesktop;
    static byte[] Read(IntPtr handle) {
        if (handle == IntPtr.Zero) throw new Win32Exception();
        uint info=4, needed;
        GetUserObjectSecurity(handle, ref info, null, 0, out needed);
        var bytes=new byte[needed];
        if (!GetUserObjectSecurity(handle, ref info, bytes, needed, out needed)) throw new Win32Exception();
        return bytes;
    }
    static void Write(IntPtr handle, byte[] bytes) {
        uint info=4;
        if (!SetUserObjectSecurity(handle, ref info, bytes)) throw new Win32Exception();
    }
    static void Allow(IntPtr handle, byte[] original, string sid, int rights) {
        var sd=new RawSecurityDescriptor(original,0);
        if (sd.DiscretionaryAcl == null) return;
        sd.DiscretionaryAcl.InsertAce(sd.DiscretionaryAcl.Count,
            new CommonAce(AceFlags.None,AceQualifier.AccessAllowed,rights,new SecurityIdentifier(sid),false,null));
        var bytes=new byte[sd.BinaryLength]; sd.GetBinaryForm(bytes,0); Write(handle,bytes);
    }
    public CiDesktopAccess(string sid) {
        station=GetProcessWindowStation(); desktop=GetThreadDesktop(GetCurrentThreadId());
        oldStation=Read(station); oldDesktop=Read(desktop);
        try {
            // Same full access a user normally has on their own interactive desktop.
            Allow(station,oldStation,sid,0x000F037F);
            Allow(desktop,oldDesktop,sid,0x000F01FF);
        } catch { Write(station,oldStation); Write(desktop,oldDesktop); throw; }
    }
    public void Dispose() { Write(desktop,oldDesktop); Write(station,oldStation); }
}
