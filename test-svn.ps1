$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Add-Type @"
using System.Net;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
public class TrustAllCertsPolicy : ICertificatePolicy {
    public bool CheckValidationResult(ServicePoint srvPoint, X509Certificate certificate, WebRequest request, int certificateProblem) {
        return true;
    }
}
"@
[System.Net.ServicePointManager]::CertificatePolicy = New-Object TrustAllCertsPolicy

# Try with explicit NTLM credentials
$cred = New-Object System.Net.NetworkCredential("simonhuang", "PChome2313678023056", "UNIVERSALEC")
$credCache = New-Object System.Net.CredentialCache
$credCache.Add([Uri]"https://svn01.universalec.com.tw/", "NTLM", $cred)
$credCache.Add([Uri]"https://svn01.universalec.com.tw/", "Negotiate", $cred)

try {
    $req = [System.Net.HttpWebRequest]::Create("https://svn01.universalec.com.tw/")
    $req.Credentials = $credCache
    $req.PreAuthenticate = $false
    $req.UnsafeAuthenticatedConnectionSharing = $true
    $req.Method = "GET"
    $req.Timeout = 15000
    $resp = $req.GetResponse()
    $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
    $body = $sr.ReadToEnd()
    Write-Output "SUCCESS! STATUS: $($resp.StatusCode)"
    Write-Output "LENGTH: $($body.Length)"
    Write-Output "BODY: $($body.Substring(0, [Math]::Min(500, $body.Length)))"
    $sr.Close()
    $resp.Close()
} catch [System.Net.WebException] {
    $we = $_.Exception
    Write-Output "NTLM_EXPLICIT_FAIL: $($we.Message)"
    if ($we.Response) {
        Write-Output "STATUS: $($we.Response.StatusCode)"
    }
}

# Try 2: with Windows AD credentials (SimonHuang AD password, not SVN password)
Write-Output ""
Write-Output "--- Try with DefaultNetworkCredentials + CredentialCache ---"
$credCache2 = New-Object System.Net.CredentialCache
$credCache2.Add([Uri]"https://svn01.universalec.com.tw/", "NTLM", [System.Net.CredentialCache]::DefaultNetworkCredentials)
$credCache2.Add([Uri]"https://svn01.universalec.com.tw/", "Negotiate", [System.Net.CredentialCache]::DefaultNetworkCredentials)

try {
    $req2 = [System.Net.HttpWebRequest]::Create("https://svn01.universalec.com.tw/")
    $req2.Credentials = $credCache2
    $req2.Method = "GET"
    $req2.Timeout = 15000
    $resp2 = $req2.GetResponse()
    $sr2 = New-Object System.IO.StreamReader($resp2.GetResponseStream())
    $body2 = $sr2.ReadToEnd()
    Write-Output "SUCCESS! STATUS: $($resp2.StatusCode)"
    Write-Output "LENGTH: $($body2.Length)"
    $sr2.Close()
    $resp2.Close()
} catch [System.Net.WebException] {
    Write-Output "DEFAULT_CRED_FAIL: $($_.Exception.Message)"
}
