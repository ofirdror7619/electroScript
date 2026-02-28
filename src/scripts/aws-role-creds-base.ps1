################################################################################################################################
##  IMPORTANT: Make sure you are using the latest version of Powershell (5.1 as of this writing). Download the latest version ##
##  from here: https://docs.microsoft.com/en-us/powershell/scripting/setup/installing-windows-powershell?view=powershell-6    ##
##  You may run into issues running an older version of Powershell.                                                           ##
################################################################################################################################
##  Another prerequisite for running this script is to configure your .aws/credentials file with the following profile:       ##
##                                                                                                                            ##
##  [nice-identity]                                                                                                           ##
##  aws_access_key_id = {your nice-identity user access-key}                                                                  ##
##  aws_secret_access_key = {your nice-identity user secret-key}                                                              ##
##                                                                                                                            ##
##  For more information on how to genetare access/secret key, see here:                                                      ##
##  https://tlvconfluence01.nice.com/display/WFM/AWS+SDK+Usage+with+Assumed+Roles+and+MFA                                     ##
################################################################################################################################

param(
    [string]$user = 'Ofir.Dror',
    [string]$target_profile_name = 'rec-dev',
    [string]$target_account_num = '730335479582',
    [string]$target_profile_name_codeartifact = 'GroupAccess-NICE-Developers',
    [string]$target_account_num_codeartifact = '369498121101',
    [string]$role_name = 'GroupAccess-Developers-Recording',
    [string]$role_name_codeartifact = 'GroupAccess-Developers-Recording',
    [string]$source_profile = 'nice-identity',
    [string]$main_iam_acct_num = '736763050260',
    [string]$default_region = 'us-west-2'
)

# AWS IAM user and config target_profile to use
# $user = 'Ofir.Dror' # Your AWS username
# $target_profile_name = 'rec-dev' # This is the local profile name you use to when accessing these credentials (e.g., dev, test-nvir, etc.)
# $target_account_num = '730335479582' # This is the account number of the account alias you want to access (e.g., 934137132601 is for dev. See table below for more)
# $target_profile_name_codeartifact = 'GroupAccess-NICE-Developers' # Target Profile name for codeartifact.
# $target_account_num_codeartifact = '369498121101' # This is account number for codeartifact.
# $role_name = 'GroupAccess-Developers-Recording' # Your role in the target account (old one: 'GroupAccess-NICE-Developers')
# $source_profile = 'nice-identity' # This is your profile name as you configured it in .aws/credentials
# $main_iam_acct_num = '736763050260' # This should be the nice-identity account number
# $default_region = 'us-west-2' # Default region for where your CLI session lives (e.g., us-west-2 for dev, us-east-1 for test-nvir etc.)
$MFA_SESSION = "$source_profile-mfa-session"
$DEFAULT_SESSION = "default"
$CODEARTIFACT_SESSION = "default-codeartifact"
<#
===============================================
|            Account Alias Numbers            |
===============================================
wfodev (dev/test/perf)   |    934137132601    
-----------------------------------------------
wfotest   (test-nvir)    |    557414474363    
-----------------------------------------------
wfostaging  (staging)    |    946153222386    
-----------------------------------------------
wfoprod                  |    918987959928    
-----------------------------------------------
wfocomplianceprod        |    334442430111    
-----------------------------------------------
ic-dev                   |    300813158921    
-----------------------------------------------
ic-test                  |    265671366761    
-----------------------------------------------
ic-staging               |    545209810301    
-----------------------------------------------
ic-prod                  |    737494165703    
-----------------------------------------------
ic-compliance-prod       |    751344753113    
-----------------------------------------------
nice-devops              |    369498121101
-----------------------------------------------
nice-identity            |    736763050260    
-----------------------------------------------
#>

########################### DO NOT EDIT ANYTHING BELOW THIS LINE ###########################

echo "**********************************************************************************************************"
echo "This script will obtain temporary credentials for $target_profile_name and $target_profile_name_codeartifact and store them"
echo "in your AWS CLI configuration. This will allow certain programs (e.g., IntelliJ IDEA)" 
echo "to access $target_profile_name and $target_profile_name_codeartifact through your $source_profile account."
echo "*********************************************************************************************************"

# Get MFA token from user
$mfa_device = "arn:aws:iam::" + $main_iam_acct_num + ":mfa/" + $user
$mfa_token = Read-Host -Prompt 'Enter MFA Code'
$token_expiration_seconds = 129600 # 36 Hours

# Piece together role information
$target_role = "arn:aws:iam::" + $target_account_num + ":role/" +$role_name

# Target Role for codeartifact
$target_role_codeartifact = "arn:aws:iam::" + $target_account_num_codeartifact + ":role/" +$role_name_codeartifact

# Variable to hold AccessKeyId, SecretAccessKey, and SessionToken returned
# from 'aws sts assume-role' command.

$token_creds = aws sts get-session-token --serial-number $mfa_device --duration-seconds $token_expiration_seconds --token-code $mfa_token --profile $source_profile | ConvertFrom-Json

Write-Host "Renewed AWS CLI Session with temporary credentials with MFA info..."

# Check if aws command executed successfully
if ($lastexitcode -eq 0) {
    
    # Pad credentials file with a new line to prevent cli from putting new profiles on existing lines
    $creds_file="~/.aws/credentials"
    if (-Not (Get-Content $creds_file | Select-String "$target_profile_name" -quiet)) {
        add-content -path $creds_file -value "`r`n"
    }

    # Set AWS credentials via CLI
    aws configure set aws_access_key_id $token_creds.Credentials.AccessKeyId --profile "$MFA_SESSION"
    aws configure set aws_secret_access_key $token_creds.Credentials.SecretAccessKey --profile "$MFA_SESSION"
    aws configure set aws_session_token $token_creds.Credentials.SessionToken --profile "$MFA_SESSION"
    aws configure set region $default_region --profile $target_profile_name
	aws configure set region $default_region --profile $target_profile_name_codeartifact

    echo "`n$(Get-Date -Format u) - Successfully cached token for $token_expiration_seconds seconds."
}


#function to add new lines in credentials and config files.
function addNewLine {

  param(
   [Parameter()]
   [string] $target_profile_name
  )
  
# Pad credentials file with a new line to prevent cli from putting new profiles on existing lines
        $creds_file = "~/.aws/credentials"
        if (-Not (Get-Content $creds_file | Select-String "$target_profile_name" -quiet)) {
            add-content -path $creds_file -value "`r`n"
        }
        $config_file = "~/.aws/config"
        if (-Not (Get-Content $config_file | Select-String "$target_profile_name" -quiet)) {
            add-content -path $config_file -value "`r`n"
        }
   }		


For ($hour=36; $hour -gt 0; $hour--) {
    echo "`nRenewing $target_profile_name access keys..."
    $creds = aws sts assume-role --role-arn $target_role --role-session-name $user --profile "$MFA_SESSION" --query "Credentials" | ConvertFrom-Json
    echo "`nRenewing $target_profile_name_codeartifact access keys..."
	$creds_codeartifact = aws sts assume-role --role-arn $target_role_codeartifact --role-session-name $user --profile "$MFA_SESSION" --query "Credentials" | ConvertFrom-Json
	# Check if aws command executed successfully
    if ($lastexitcode -eq 0) {
        
        addNewLine $target_profile_name 
		
        # Set AWS credentials via CLI
        aws configure set aws_access_key_id $creds.AccessKeyId --profile "$DEFAULT_SESSION"
        aws configure set aws_secret_access_key $creds.SecretAccessKey --profile "$DEFAULT_SESSION"
        aws configure set aws_session_token $creds.SessionToken --profile "$DEFAULT_SESSION"
        aws configure set region $default_region --profile "$DEFAULT_SESSION"
		
		
        echo "`n$(Get-Date -Format u) - $target_profile_name profile has been updated in ~/.aws/credentials."
		
		addNewLine $target_profile_name_codeartifact
		
		# Set AWS credentials via CLI
        aws configure set aws_access_key_id $creds_codeartifact.AccessKeyId --profile "$CODEARTIFACT_SESSION"
        aws configure set aws_secret_access_key $creds_codeartifact.SecretAccessKey --profile "$CODEARTIFACT_SESSION"
        aws configure set aws_session_token $creds_codeartifact.SessionToken --profile "$CODEARTIFACT_SESSION"
        aws configure set region $default_region --profile "$CODEARTIFACT_SESSION"

        echo "`n$(Get-Date -Format u) - $target_profile_name_codeartifact profile has been updated in ~/.aws/credentials."
		
        $CODEARTIFACT_AUTH_TOKEN=(aws codeartifact get-authorization-token --domain nice-devops --domain-owner 369498121101 --query authorizationToken --output text --region us-west-2 --profile "$CODEARTIFACT_SESSION")
	    echo "`n Generated codeArtifact Token."
	    try {
	    
		$file = "C:\Users\$env:UserName\.m2\settings.xml"
		$x = [xml] (Get-Content $file)
		$nodeId = $x.settings.servers.server | ? { $_.id -eq "cxone-codeartifact" }
			$nodeId.password = $CODEARTIFACT_AUTH_TOKEN.ToString()
		$nodeId1 = $x.settings.servers.server | ? { $_.id -eq "platform-utils" }
			$nodeId1.password = $CODEARTIFACT_AUTH_TOKEN.ToString()
			$nodeId2 = $x.settings.servers.server | ? { $_.id -eq "plugins-codeartifact" }
			$nodeId2.password = $CODEARTIFACT_AUTH_TOKEN.ToString()
		$x.Save($file)
			echo "`n Updated $file with codeartifact Token."
            } catch {
	    
	      echo "no settings.xml or using old version"
	    }
	 
        
       try {
            echo "`n Updated with codeartifact Token."
            npm config set registry "https://nice-devops-369498121101.d.codeartifact.us-west-2.amazonaws.com/npm/cxone-npm/"
            npm config set "//nice-devops-369498121101.d.codeartifact.us-west-2.amazonaws.com/npm/cxone-npm/:_authToken=${CODEARTIFACT_AUTH_TOKEN}"
            #npm config set "//nice-devops-369498121101.d.codeartifact.us-west-2.amazonaws.com/npm/cxone-npm/:always-auth=true"
        } catch {
            echo "npm not installed"
        }


        if ($hour -eq 1) {
            echo "Keep this window open to have your keys renewed every 59 minutes for the next $hour hour."
        } else {
            echo "Keep this window open to have your keys renewed every 59 minutes for the next $hour hours."
        }
        

        Start-Sleep -s 3540 # 59 minutes
    }
}

echo "MFA token credentials have expired. Please restart this script."

# Check if we're running in
if ($host.name -notmatch 'ISE')
{
    echo "`nPress any key to close this window..."
    $x = $host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") 
}
