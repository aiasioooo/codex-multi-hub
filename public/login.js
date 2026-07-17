const form = document.querySelector("#login-form");
const error = document.querySelector("#login-error");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;
  button.firstChild.textContent = "Checking ";
  try {
    const response = await fetch("/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: form.password.value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Login failed");
    location.replace("/");
  } catch (caught) {
    error.textContent = caught.message;
    form.password.select();
  } finally {
    button.disabled = false;
    button.firstChild.textContent = "Enter ";
  }
});
