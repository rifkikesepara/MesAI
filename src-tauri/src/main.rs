#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = mesai_lib::handle_cli_dpapi() {
        std::process::exit(code);
    }
    mesai_lib::run();
}
