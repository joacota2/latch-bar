//! Private GitHub releases use the user's existing gh login. Credentials stay
//! in native memory; both metadata and binaries use repository-scoped API URLs.
use serde::Deserialize;
use std::{path::PathBuf, time::Duration};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

const REPOSITORY: &str = "joacota2/latch-bar";
const LOGIN_HELP: &str = "Private releases require GitHub CLI access. Run gh auth login --hostname github.com with an account that can read joacota2/latch-bar, then try again.";

#[derive(Deserialize)]
struct Asset {
    id: u64,
    name: String,
    url: String,
    browser_download_url: String,
}
#[derive(Deserialize)]
struct Release {
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}

fn gh_path() -> PathBuf {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    paths
        .into_iter()
        .map(|path| path.join("gh"))
        .find(|path| path.is_file())
        .unwrap_or_else(|| "gh".into())
}
async fn gh(args: &[&str]) -> Result<String, String> {
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        tokio::process::Command::new(gh_path())
            .args(args)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_HOST", "github.com")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "GitHub access timed out. Please try again.".to_string())?
    .map_err(|_| LOGIN_HELP.to_string())?;
    // Never surface CLI stderr/stdout on failure: it may contain credentials.
    if !output.status.success() {
        return Err(LOGIN_HELP.into());
    }
    String::from_utf8(output.stdout).map_err(|_| "GitHub returned invalid data.".into())
}
fn asset_url(asset: &Asset) -> Result<String, String> {
    let expected = format!(
        "https://api.github.com/repos/{REPOSITORY}/releases/assets/{}",
        asset.id
    );
    if asset.url != expected {
        return Err("The release contains an unexpected asset URL.".into());
    }
    Ok(expected)
}
impl Release {
    fn manifest_url(&self) -> Result<String, String> {
        if self.draft || self.prerelease {
            return Err("The latest release is not a stable published release.".into());
        }
        asset_url(
            self.assets
                .iter()
                .find(|asset| asset.name == "latest.json")
                .ok_or("The release has no updater manifest.")?,
        )
    }
    fn download_url(&self, manifest_url: &str) -> Result<String, String> {
        let asset = self
            .assets
            .iter()
            .find(|asset| {
                asset.browser_download_url == manifest_url && asset.name.ends_with(".app.tar.gz")
            })
            .ok_or("The updater archive is not an asset of this release.")?;
        asset_url(asset)
    }
}

pub async fn check(app: &AppHandle) -> Result<Option<Update>, String> {
    // Preserve explicit test/distribution endpoint overrides, without attaching
    // GitHub credentials to those endpoints.
    let configured = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|value| value.get("endpoints"));
    if configured
        != Some(&serde_json::json!([format!(
            "https://github.com/{REPOSITORY}/releases/latest/download/latest.json"
        )]))
    {
        return app
            .updater_builder()
            .timeout(Duration::from_secs(20))
            .version_comparator(|current, release| {
                release.version.pre.is_empty() && release.version > current
            })
            .build()
            .map_err(|error| error.to_string())?
            .check()
            .await
            .map_err(|error| error.to_string());
    }
    let metadata = gh(&[
        "api",
        &format!("repos/{REPOSITORY}/releases/latest"),
        "--jq",
        "{draft,prerelease,assets:[.assets[]|{id,name,url,browser_download_url}]}",
    ])
    .await?;
    let release: Release =
        serde_json::from_str(&metadata).map_err(|_| "GitHub returned invalid release metadata.")?;
    let manifest = release.manifest_url()?;
    let token = gh(&["auth", "token", "--hostname", "github.com"]).await?;
    // Check the repository-scoped manifest through the official updater. Its
    // pinned public key still verifies every downloaded archive before install.
    let updater = app
        .updater_builder()
        .endpoints(vec![manifest
            .parse()
            .map_err(|_| "Invalid manifest URL")?])
        .map_err(|_| "Invalid updater endpoint")?
        .header("Authorization", format!("Bearer {}", token.trim()))
        .map_err(|_| "Invalid GitHub credential")?
        .header("Accept", "application/octet-stream")
        .map_err(|_| "Invalid updater headers")?
        .timeout(Duration::from_secs(20))
        .version_comparator(|current, release| {
            release.version.pre.is_empty() && release.version > current
        })
        .build()
        .map_err(|_| "Could not initialize the updater")?;
    let mut update = updater.check().await.map_err(|_| {
        "Could not read the private release manifest. Check GitHub access and try again."
    })?;
    if let Some(update) = &mut update {
        update.download_url = release
            .download_url(update.download_url.as_str())?
            .parse()
            .map_err(|_| "Invalid archive URL")?;
    }
    // The token is never persisted or included in UpdateState/events.
    Ok(update)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release() -> Release {
        Release { draft: false, prerelease: false, assets: vec![
            Asset { id: 1, name: "latest.json".into(), url: format!("https://api.github.com/repos/{REPOSITORY}/releases/assets/1"), browser_download_url: "https://github.com/joacota2/latch-bar/releases/download/v1/latest.json".into() },
            Asset { id: 2, name: "Latch.Bar.app.tar.gz".into(), url: format!("https://api.github.com/repos/{REPOSITORY}/releases/assets/2"), browser_download_url: "https://github.com/joacota2/latch-bar/releases/download/v1/Latch.Bar.app.tar.gz".into() },
        ] }
    }
    #[test]
    fn private_manifest_and_archive_use_authenticated_asset_endpoints() {
        let release = release();
        assert!(release.manifest_url().unwrap().ends_with("/assets/1"));
        assert!(release
            .download_url(&release.assets[1].browser_download_url)
            .unwrap()
            .ends_with("/assets/2"));
    }
    #[test]
    fn untrusted_or_unpublished_assets_are_rejected_before_credentials_are_used() {
        let mut release = release();
        assert!(release
            .download_url("https://attacker.example/archive.app.tar.gz")
            .is_err());
        release.assets[0].url = "https://attacker.example/latest.json".into();
        assert!(release.manifest_url().is_err());
        release = super::tests::release();
        release.assets[1].url = "https://api.github.com/repos/other/repo/releases/assets/2".into();
        assert!(release
            .download_url(&release.assets[1].browser_download_url)
            .is_err());
        release.prerelease = true;
        assert!(release.manifest_url().is_err());
    }
}
