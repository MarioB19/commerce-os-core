#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{io::Write, path::PathBuf, process::{Child, Command, Stdio}, sync::{Mutex,atomic::{AtomicBool,Ordering}}};
use tauri::{Manager, menu::{Menu, MenuItem}, tray::TrayIconBuilder};
use tauri_plugin_autostart::ManagerExt;
struct Worker(Mutex<Option<Child>>);
struct Admission(Mutex<bool>);
struct Closing(AtomicBool);
fn runtime(app: &tauri::AppHandle) -> Result<(PathBuf,PathBuf),String> {
 let resources=app.path().resource_dir().map_err(|_|"RESOURCE_DIRECTORY")?.join("runtime");
 let exe=std::env::current_exe().map_err(|_|"EXECUTABLE_DIRECTORY")?;
 let node=exe.parent().ok_or("EXECUTABLE_DIRECTORY")?.join(if cfg!(windows){"commerce-node.exe"}else{"commerce-node"});
 if !node.is_file() || !resources.join("worker.mjs").is_file(){return Err("RUNTIME_MISSING".into());}
 Ok((node,resources))
}
fn own_command(app:&tauri::AppHandle, operation:&str)->Result<Command,String>{let(node,resources)=runtime(app)?;let mut cmd=Command::new(node);cmd.arg(resources.join("worker.mjs")).arg(operation).env("COMMERCE_RUNTIME_RESOURCES",&resources).stdin(Stdio::piped());
 #[cfg(windows)]{use std::os::windows::process::CommandExt;cmd.creation_flags(0x08000000);}
 Ok(cmd)
}
fn control_command(app:tauri::AppHandle, operation:String, input:Option<serde_json::Value>)->Result<serde_json::Value,String>{
 if !["configure","configuration","doctor","status","pause","resume","resources","pair","pair-poll","backup","update","rollback"].contains(&operation.as_str()){return Err("COMMAND_NOT_ALLOWED".into());}
 if ["configure","update","rollback"].contains(&operation.as_str()) {let state=app.state::<Worker>();let mut guard=state.0.lock().map_err(|_|"WORKER_LOCK")?;if let Some(child)=guard.as_mut(){if child.try_wait().map_err(|_|"WORKER_STATUS")?.is_none(){return Err("STOP_WORKER_FIRST".into());}}}
 let mut child=own_command(&app,&operation)?.arg(serde_json::to_string(&input.unwrap_or(serde_json::json!({}))).map_err(|_|"INPUT_INVALID")?).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|_|"WORKER_COMMAND_FAILED")?;
 let started=std::time::Instant::now();while child.try_wait().map_err(|_|"WORKER_COMMAND_FAILED")?.is_none(){if started.elapsed()>std::time::Duration::from_secs(30){let _=child.kill();let _=child.wait();return Err("COMMAND_TIMEOUT_CHECK_DISK_PERMISSION".into());}std::thread::sleep(std::time::Duration::from_millis(50));}let output=child.wait_with_output().map_err(|_|"WORKER_COMMAND_FAILED")?;
 if !output.status.success(){return Err(String::from_utf8_lossy(&output.stderr).trim().chars().take(120).collect());}
 serde_json::from_slice(&output.stdout).map_err(|_|"WORKER_RESPONSE_INVALID".into())
}
#[tauri::command]
async fn worker_command(app:tauri::AppHandle,operation:String,input:Option<serde_json::Value>)->Result<serde_json::Value,String>{tauri::async_runtime::spawn_blocking(move||control_command(app,operation,input)).await.map_err(|_|"WORKER_COMMAND_FAILED".to_string())?}
#[tauri::command]
fn start_worker(app:tauri::AppHandle)->Result<(),String>{*app.state::<Admission>().0.lock().map_err(|_|"WORKER_LOCK")?=true;let state=app.state::<Worker>();let mut guard=state.0.lock().map_err(|_|"WORKER_LOCK")?;if let Some(child)=guard.as_mut(){if child.try_wait().map_err(|_|"WORKER_STATUS")?.is_none(){return Ok(());}}let child=own_command(&app,"start")?.arg("--stdio-control").stdout(Stdio::null()).stderr(Stdio::null()).spawn().map_err(|_|"WORKER_START_FAILED")?;*guard=Some(child);Ok(())}
fn stop(app:&tauri::AppHandle)->Result<(),String>{*app.state::<Admission>().0.lock().map_err(|_|"WORKER_LOCK")?=false;let state=app.state::<Worker>();let mut guard=state.0.lock().map_err(|_|"WORKER_LOCK")?;if let Some(child)=guard.as_mut(){if let Some(stdin)=child.stdin.as_mut(){stdin.write_all(b"stop\n").map_err(|_|"WORKER_STOP_FAILED")?;}}Ok(())}
#[tauri::command]
fn stop_worker(app:tauri::AppHandle)->Result<(),String>{stop(&app)}
#[tauri::command]
fn set_autostart(app:tauri::AppHandle, enabled:bool)->Result<(),String>{if enabled{app.autolaunch().enable()}else{app.autolaunch().disable()}.map_err(|_|"AUTOSTART_FAILED".into())}
#[tauri::command]
fn autostart_enabled(app:tauri::AppHandle)->Result<bool,String>{app.autolaunch().is_enabled().map_err(|_|"AUTOSTART_STATUS_FAILED".into())}
#[tauri::command]
fn open_commerce()->Result<(),String>{let url="https://commerce-os.inovaris.online/studio";
 #[cfg(target_os="macos")]let result=Command::new("/usr/bin/open").arg(url).spawn();
 #[cfg(windows)]let result=Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler",url]).spawn();
 #[cfg(not(any(target_os="macos",windows)))]let result=Command::new("xdg-open").arg(url).spawn();
 result.map(|_|()).map_err(|_|"OPEN_BROWSER_FAILED".into())
}
fn request_exit(app:&tauri::AppHandle){if app.state::<Closing>().0.swap(true,Ordering::SeqCst){return;}let _=stop(app);let handle=app.clone();std::thread::spawn(move||{loop{let finished={let state=handle.state::<Worker>();let mut guard=state.0.lock().unwrap();match guard.as_mut(){Some(child)=>child.try_wait().ok().flatten().is_some(),None=>true}};if finished{handle.exit(0);break;}std::thread::sleep(std::time::Duration::from_secs(1));}});}
fn main(){let app=tauri::Builder::default()
 .plugin(tauri_plugin_single_instance::init(|app,_args,_cwd|{if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}}))
 .plugin(tauri_plugin_autostart::Builder::new().args(["--autostart"]).build())
 .manage(Worker(Mutex::new(None))).manage(Admission(Mutex::new(false))).manage(Closing(AtomicBool::new(false)))
 .invoke_handler(tauri::generate_handler![worker_command,start_worker,stop_worker,set_autostart,autostart_enabled,open_commerce])
 .setup(|app|{let show=MenuItem::with_id(app,"show","Abrir Commerce Worker",true,None::<&str>)?;let pause=MenuItem::with_id(app,"pause","Pausar nuevos trabajos",true,None::<&str>)?;let quit=MenuItem::with_id(app,"quit","Salir al terminar el trabajo",true,None::<&str>)?;let menu=Menu::with_items(app,&[&show,&pause,&quit])?;
 let mut tray=TrayIconBuilder::new().menu(&menu).tooltip("Commerce Worker · Experimental");if let Some(icon)=app.default_window_icon(){tray=tray.icon(icon.clone());}
 tray.on_menu_event(|app,event|match event.id.as_ref(){"show"=>{if let Some(w)=app.get_webview_window("main"){let _=w.show();let _=w.set_focus();}},"pause"=>{let handle=app.clone();std::thread::spawn(move||{let _=control_command(handle,"pause".into(),None);});},"quit"=>request_exit(app),_=>{}}).build(app)?;
 let handle=app.handle().clone();std::thread::spawn(move||{let mut restarts=0;loop{std::thread::sleep(std::time::Duration::from_secs(5));let admitted=*handle.state::<Admission>().0.lock().unwrap();if !admitted{restarts=0;continue;}let crashed={let state=handle.state::<Worker>();let mut guard=state.0.lock().unwrap();guard.as_mut().and_then(|child|child.try_wait().ok().flatten()).is_some()};if crashed&&restarts<3{restarts+=1;let _=start_worker(handle.clone());}}});
 if std::env::args().any(|a|a=="--autostart"){let _=start_worker(app.handle().clone());}Ok(())})
 .on_window_event(|window,event|{if let tauri::WindowEvent::CloseRequested{api,..}=event{api.prevent_close();let _=window.hide();}})
 .build(tauri::generate_context!()).expect("Commerce Worker could not start");
 app.run(|app,event|{if let tauri::RunEvent::ExitRequested{api,..}=event{let running={let state=app.state::<Worker>();let mut guard=state.0.lock().unwrap();guard.as_mut().is_some_and(|child|child.try_wait().ok().flatten().is_none())};if running{api.prevent_exit();request_exit(app);}}});}
