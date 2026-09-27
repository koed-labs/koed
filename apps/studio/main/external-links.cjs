function isGithubPullRequestUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://github.com" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*$/.test(
        url.pathname
      )
    );
  } catch {
    return false;
  }
}

module.exports = { isGithubPullRequestUrl };
