const form = document.getElementById("setup-form");
const button = document.getElementById("submit-button");
const errorMessage = document.getElementById("error-message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorMessage.textContent = "";
  const loginKey = document.getElementById("login-key").value;
  const confirmation = document.getElementById("confirmation").value;
  if (loginKey !== confirmation) {
    errorMessage.textContent = "两次输入的登录密钥不一致。";
    document.getElementById("confirmation").focus();
    return;
  }
  button.disabled = true;
  button.textContent = "正在保存…";
  try {
    await window.subscriptionButlerSetup.save(loginKey, confirmation);
    form.reset();
  } catch (error) {
    errorMessage.textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /u, "");
    button.disabled = false;
    button.textContent = "保存并开始使用";
  }
});
