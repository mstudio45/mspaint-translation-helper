"use server";

import { auth } from "@/auth";
import { Session } from "next-auth";

interface Fork {
    owner: {
        login: string;
    };
}

/*
Ignore this im just breaking down the thingy so this less complicated for me to implement

- check for write permissions (mspaint-cc/translations)
   - if not then fork the repo and then create a PR then return a JSON that contains the PR link
      - to create a PR we need to create a branch and then push it to the repo
      - then we need to create a PR from the branch to the main branch

   - if they do then directly modify the file.

*/
export async function publish_translations(translations: Record<string, string>, lang: string) {
    const session = await auth() as Session & { accessToken: string };
    if (!session || !session.accessToken) return;

    const filePath = getLocaleFilePath(lang);

    // User info
    const userResponse = await fetch("https://api.github.com/user", {
        headers: {
            Authorization: `token ${session?.accessToken}`,
        }
    });
    const userData = await userResponse.json();
    const username = userData.login;

    // Permission check
    const response = await fetch("https://api.github.com/repos/mspaint-cc/translations", {
        headers: {
            Authorization: `token ${session?.accessToken}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "Accept": "application/vnd.github+json",
        },
        next: {
            revalidate: 60 * 60 * 24,
        }
    });
    
    const repoData = await response.json();
    const hasWriteAccess = repoData.permissions?.push;
    
    if (!hasWriteAccess) {
        // Check if user already has a fork
        const forksResponse = await fetch(`https://api.github.com/repos/mspaint-cc/translations/forks`, {
            headers: {
            Authorization: `token ${session?.accessToken}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "Accept": "application/vnd.github+json",
            }
        });
        
        const forks = await forksResponse.json();
        const userFork = forks.find((fork: Fork) => fork.owner.login === username);
        
        // If user doesn't have a fork, create one else sync fork with upstream
        if (!userFork) {
            const forkResponse = await fetch(`https://api.github.com/repos/mspaint-cc/translations/forks`, {
            method: "POST",
            headers: {
                Authorization: `token ${session?.accessToken}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "Accept": "application/vnd.github+json",
            }
            });
            
            if (forkResponse.status !== 202) {
            return {
                success: false,
                message: {
                message: "Failed to fork repository",
                description: `Failed to fork the repository (${forkResponse.status}). Please try again later.`
                }
            }
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
            try {
                await fetch(`https://api.github.com/repos/${username}/translations/merge-upstream`, {
                    method: "POST",
                    headers: {
                        Authorization: `token ${session?.accessToken}`,
                        "X-GitHub-Api-Version": "2022-11-28",
                        "Accept": "application/vnd.github+json",
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                        branch: "main"
                    })
                });
            } catch (e) {
                console.error("Failed to sync fork with upstream", e);
            }
        }
        
        // Create a new branch for PR
        // First, get the current commit SHA from main
        const refResponse = await fetch(`https://api.github.com/repos/${username}/translations/git/refs/heads/main`, {
            headers: {
                Authorization: `token ${session?.accessToken}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "Accept": "application/vnd.github+json",
            }
        });
        
        if (refResponse.status !== 200) {
            return {
                success: false,
                message: {
                    message: "Failed to get reference",
                    description: `Failed to get reference to main branch (${refResponse.status}). Please try again later.`
                }
            }
        }
        
        const refData = await refResponse.json();
        const mainSha = refData.object.sha;
        
        // Create a new branch
        const branchName = `update-${lang.replace('-', '-')}-translations-${Date.now()}`;
        const createBranchResponse = await fetch(`https://api.github.com/repos/${username}/translations/git/refs`, {
            method: "POST",
            headers: {
                Authorization: `token ${session?.accessToken}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                ref: `refs/heads/${branchName}`,
                sha: mainSha
            })
        });
        
        if (createBranchResponse.status !== 201) {
            return {
                success: false,
                message: {
                    message: "Failed to create branch",
                    description: `Failed to create branch for changes (${createBranchResponse.status}). Please try again later.`
                }
            }
        }
        
        // Get current file if it exists
        const fileResponse = await fetch(`https://api.github.com/repos/${username}/translations/contents/translations/${filePath}`, {
            headers: {
                Authorization: `token ${session?.accessToken}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "Accept": "application/vnd.github+json",
            }
        });
        
        let fileSha;
        if (fileResponse.status === 200) {
            const fileData = await fileResponse.json();
            fileSha = fileData.sha;
        }
        
        // Update the file in the new branch
        const fileContent = JSON.stringify(translations, null, 2);
        const updateFileResponse = await fetch(`https://api.github.com/repos/${username}/translations/contents/translations/${filePath}`, {
            method: "PUT",
            headers: {
                Authorization: `token ${session?.accessToken}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                message: `feat: updated ${lang} translation`,
                content: Buffer.from(fileContent).toString("base64"),
                sha: fileSha, // Only included if file exists
                branch: branchName
            })
        });
        
        if (updateFileResponse.status !== 200 && updateFileResponse.status !== 201) {
            return {
                success: false,
                message: {
                    message: "Failed to update file",
                    description: `Failed to update translations file (${updateFileResponse.status}). Please try again later.`
                }
            }
        }
        
        // Create pull request
        const prResponse = await fetch(`https://api.github.com/repos/mspaint-cc/translations/pulls`, {
            method: "POST",
            headers: {
                Authorization: `token ${session?.accessToken}`,
                "X-GitHub-Api-Version": "2022-11-28",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                title: `Update ${lang} translations`,
                body: `This PR updates the translations for ${lang}.`,
                head: `${username}:${branchName}`,
                base: "main"
            })
        });
        
        if (prResponse.status !== 201) {
            return {
                success: false,
                message: {
                    message: "Failed to create PR",
                    description: `Failed to create pull request (${prResponse.status}). Please try again later.`
                }
            }
        }
        
        const prData = await prResponse.json();
        
        return {
            success: true,
            message: {
                message: "Your changes are in review!",
                description: "We have created a PR with your translation changes.",
                action: {
                    label: "View PR",
                    onClick: "OPEN_LINK",
                    href: prData.html_url
                }
            }
        }
    };

    // Get file sha
    const fileResponse = await fetch(`https://api.github.com/repos/mspaint-cc/translations/contents/translations/${filePath}`, {
        method: "GET",
        headers: {
            "X-GitHub-Api-Version": "2022-11-28",
            "Accept": "application/vnd.github+json",
            Authorization: `token ${session?.accessToken}`,
        }
    });

    let fileData;
    try {
        fileData = await fileResponse.json();
    } catch  {
        return {
            success: false,
            message: {
                message: "Failed to fetch file",
                description: "Failed to fetch the translations file. Please try again later."
            }
        }
    }

    const fileSha = fileData.sha;
    const fileContent = JSON.stringify(translations, null, 2);

    // Update file
    const commitResponse = await fetch(`https://api.github.com/repos/mspaint-cc/translations/contents/translations/${filePath}`, {
        method: "PUT",
        headers: {
            "X-GitHub-Api-Version": "2022-11-28",
            "Accept": "application/vnd.github+json",
            "Authorization": `token ${session?.accessToken}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            message: `feat: updated ${lang} translation`,
            content: Buffer.from(fileContent).toString("base64"),
            sha: fileSha,
            branch: "main"
        })
    });

    if (commitResponse.status !== 200) {
        return {
            success: false,
            message: {
                message: "Failed to commit changes",
                description: `Had an HTTP error (${commitResponse.status}) while committing changes to the translations file. Please try again later.`
            }
        }
    }

    return {
        success: true,
        message: {
            message: "Translations updated!",
            description: "Your translations have been successfully updated.",
            action: {
                label: "Show changes",
                onClick: "OPEN_LINK",
                href: "https://github.com/mspaint-cc/translations/commits/main/"
            }
        }
    }
}

/**
 "zh-cn" -> "zh/cn.json"
 "fr" -> "fr.json"
 */
function getLocaleFilePath(locale: string): string {
    if (locale.includes('-')) {
        const [main, sub] = locale.split('-');
        return `${main}/${sub}.json`;
    }
    return `${locale}.json`;
}