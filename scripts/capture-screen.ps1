<#
Capture the screen and emit JSON describing the capture.

Called by screen.mjs. Does three things in one pass so Node never has to decode
a PNG:

  1. saves a downscaled PNG for the vision model (full resolution is a waste of
     tokens and the model reads a 1600px-wide frame fine)
  2. computes a 64-bit average hash from an 8x8 grayscale downsample, so Node
     can tell "nothing changed" without looking at pixels
  3. reports the monitor geometry

Output: a single line of JSON on stdout. Any failure prints JSON with an "error"
key rather than a PowerShell stack trace, so the caller always gets parseable
output.

  -OutPath   where to write the PNG (required)
  -Monitor   0 = primary (default), -1 = all monitors stitched, N = that screen
  -MaxWidth  downscale target, default 1600
#>
param(
  [Parameter(Mandatory = $true)][string]$OutPath,
  [int]$Monitor = 0,
  [int]$MaxWidth = 1600
)

$ErrorActionPreference = "Stop"

function Write-Json($obj) {
  $obj | ConvertTo-Json -Compress -Depth 5 | Write-Output
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing

  $screens = [System.Windows.Forms.Screen]::AllScreens

  if ($Monitor -lt 0) {
    # All monitors stitched into one virtual desktop image.
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $label  = "all ($($screens.Count) monitors)"
  } elseif ($Monitor -eq 0) {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $label  = "primary"
  } else {
    if ($Monitor -ge $screens.Count) {
      Write-Json @{ error = "monitor $Monitor does not exist; $($screens.Count) attached" }
      exit 1
    }
    $bounds = $screens[$Monitor].Bounds
    $label  = "monitor $Monitor"
  }

  $full = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $g = [System.Drawing.Graphics]::FromImage($full)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $g.Dispose()

  # ── average hash: 8x8 grayscale, bit set when brighter than the mean ──
  $tiny = New-Object System.Drawing.Bitmap 8, 8
  $tg = [System.Drawing.Graphics]::FromImage($tiny)
  $tg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $tg.DrawImage($full, 0, 0, 8, 8)
  $tg.Dispose()

  $levels = New-Object 'System.Collections.Generic.List[double]'
  for ($y = 0; $y -lt 8; $y++) {
    for ($x = 0; $x -lt 8; $x++) {
      $p = $tiny.GetPixel($x, $y)
      $levels.Add(0.299 * $p.R + 0.587 * $p.G + 0.114 * $p.B)
    }
  }
  $mean = ($levels | Measure-Object -Average).Average
  $bits = New-Object System.Text.StringBuilder
  foreach ($l in $levels) { [void]$bits.Append($(if ($l -gt $mean) { "1" } else { "0" })) }
  $bitString = $bits.ToString()

  $hash = ""
  for ($i = 0; $i -lt 64; $i += 4) {
    $nibble = [Convert]::ToInt32($bitString.Substring($i, 4), 2)
    $hash += "{0:x}" -f $nibble
  }
  $tiny.Dispose()

  # ── downscale for the vision model ──
  $outWidth  = $bounds.Width
  $outHeight = $bounds.Height
  if ($MaxWidth -gt 0 -and $bounds.Width -gt $MaxWidth) {
    $scale     = $MaxWidth / $bounds.Width
    $outWidth  = [int]$MaxWidth
    $outHeight = [int][Math]::Round($bounds.Height * $scale)
  }

  if ($outWidth -ne $bounds.Width) {
    $scaled = New-Object System.Drawing.Bitmap $outWidth, $outHeight
    $sg = [System.Drawing.Graphics]::FromImage($scaled)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($full, 0, 0, $outWidth, $outHeight)
    $sg.Dispose()
    $scaled.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $scaled.Dispose()
  } else {
    $full.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $full.Dispose()

  Write-Json @{
    path     = (Resolve-Path $OutPath).Path
    width    = $outWidth
    height   = $outHeight
    source   = $label
    monitors = $screens.Count
    hash     = $hash
    bytes    = (Get-Item $OutPath).Length
  }
} catch {
  Write-Json @{ error = $_.Exception.Message }
  exit 1
}
