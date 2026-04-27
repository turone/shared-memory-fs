<#
.SYNOPSIS
  Syncs branch-specific Copilot instruction files from the CopilotInstructions
  branch into the current working directory without staging them.

.DESCRIPTION
  Fetches the latest CopilotInstructions branch from origin, extracts
  .github/instructions/ files into the working tree, then unstages them
  so they remain untracked. Also ensures .git/info/exclude hides them
  from git status.

.EXAMPLE
  .github/scripts/sync-instructions.ps1
#>

$ErrorActionPreference = 'Stop'
$branch = 'CopilotInstructions'
$remote = 'origin'
$instructionsPath = '.github/instructions/'
$scriptsPath = '.github/scripts/'
$copilotInstructions = '.github/copilot-instructions.md'
$agentsFile = 'AGENTS.md'
$excludeFile = '.git/info/exclude'
$excludePatterns = @(
    '.github/instructions/*.instructions.md',
    '.github/scripts/',
    '.github/copilot-instructions.md',
    'AGENTS.md'
)

# Fetch latest
Write-Host "Fetching $remote/$branch..."
git fetch $remote $branch

# Extract instruction files and scripts into working directory
Write-Host "Extracting instruction files and scripts..."
git checkout "$remote/$branch" -- $instructionsPath $scriptsPath $copilotInstructions $agentsFile

# Unstage so they stay untracked
git reset HEAD -- $instructionsPath $scriptsPath $copilotInstructions $agentsFile 2>$null

# Ensure .git/info/exclude has the patterns
if (!(Test-Path $excludeFile)) {
    New-Item -Path $excludeFile -ItemType File -Force | Out-Null
}
$content = Get-Content $excludeFile -Raw -ErrorAction SilentlyContinue
if (!$content) { $content = '' }
foreach ($pattern in $excludePatterns) {
    if ($content -notmatch [regex]::Escape($pattern)) {
        Add-Content $excludeFile $pattern
        Write-Host "Added '$pattern' to $excludeFile"
    }
}

Write-Host 'Done. Instruction files are present but untracked.'
