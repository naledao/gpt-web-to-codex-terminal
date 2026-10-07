package cli

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	"web2term/agent/internal/auth"
	"web2term/agent/internal/config"
	"web2term/agent/internal/diagnostic"
)

type loginAPI interface {
	SendCode(context.Context, string) error
	Login(context.Context, string, string) (auth.LoginResponse, error)
}

func login(input io.Reader, output io.Writer, path string) error {
	server, err := config.Server(path)
	if err != nil {
		return err
	}
	server, err = config.NormalizeServerURL(server)
	if err != nil {
		return errors.New("请先运行 web2term set server 配置有效的后端请求地址")
	}
	client, err := auth.NewClient(server)
	if err != nil {
		return err
	}
	log, logErr := diagnostic.Open("", output)
	if logErr != nil {
		if _, err := fmt.Fprintln(output, "警告：无法创建诊断日志，请检查系统临时目录权限；登录流程继续。"); err != nil {
			return err
		}
	} else {
		defer log.Close()
	}
	client.SetLogger(log)
	return loginWithClient(input, output, path, server, client, time.Now, log)
}

func loginWithClient(input io.Reader, output io.Writer, path, server string, client loginAPI, now func() time.Time, log *diagnostic.Log) (resultError error) {
	outcome := "cancelled"
	log.Record(diagnostic.Entry{Event: "login_started"})
	defer func() {
		if resultError != nil {
			outcome = "failed"
		}
		log.Record(diagnostic.Entry{Event: "login_finished", Outcome: outcome, Error: diagnostic.DescribeError(resultError)})
	}()
	if log != nil {
		if _, err := fmt.Fprintf(output, "诊断日志：%s\n", log.Path()); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintf(output, "登录后端：%s\n按 Ctrl+C 取消。\n", server); err != nil {
		return err
	}
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 1024), 8192)
	var email string
	for {
		value, cancelled, err := loginInput(scanner, output, "请输入登录邮箱：")
		if err != nil || cancelled {
			return err
		}
		email, err = auth.NormalizeEmail(value)
		if err == nil {
			break
		}
		log.Record(diagnostic.Entry{Event: "email_input_invalid"})
		if _, err := fmt.Fprintln(output, err); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintln(output, "正在发送登录验证码……"); err != nil {
		return err
	}
	if err := client.SendCode(context.Background(), email); err != nil {
		return fmt.Errorf("发送验证码失败：%w", err)
	}
	log.Record(diagnostic.Entry{Event: "code_sent", Phase: "send_code"})
	if _, err := fmt.Fprintln(output, "验证码已发送，请查看邮箱。验证码错误或过期后，可取消并重新登录以获取新验证码。"); err != nil {
		return err
	}
	for {
		value, cancelled, err := loginInput(scanner, output, "请输入 6 位验证码：")
		if err != nil || cancelled {
			return err
		}
		code, err := auth.NormalizeCode(value)
		if err != nil {
			log.Record(diagnostic.Entry{Event: "code_input_invalid"})
			if _, err := fmt.Fprintln(output, err); err != nil {
				return err
			}
			continue
		}
		if _, err := fmt.Fprintln(output, "正在登录……"); err != nil {
			return err
		}
		result, err := client.Login(context.Background(), email, code)
		if err != nil {
			var apiError *auth.APIError
			if errors.As(err, &apiError) && apiError.StatusCode == 401 && apiError.Code == "LOGIN_CODE_INCORRECT" {
				log.Record(diagnostic.Entry{Event: "code_retry", Phase: "login", Status: apiError.StatusCode, Code: apiError.Code})
				if _, err := fmt.Fprintf(output, "%s，请重新输入或按 Ctrl+C 取消。\n", apiError); err != nil {
					return err
				}
				continue
			}
			return fmt.Errorf("登录失败：%w", err)
		}
		receivedAt := now().UTC()
		log.Record(diagnostic.Entry{Event: "config_save_started"})
		if err := config.SaveLogin(path, server, result, receivedAt); err != nil {
			log.Record(diagnostic.Entry{Event: "config_save_failed", Error: diagnostic.DescribeError(err)})
			return err
		}
		outcome = "success"
		log.Record(diagnostic.Entry{Event: "config_saved"})
		expiresAt := receivedAt.Add(time.Duration(result.ExpiresInSeconds) * time.Second)
		_, err = fmt.Fprintf(output, "登录成功：%s\n用户 ID：%s\n登录有效期至：%s（UTC）\n登录信息已保存：%s\n",
			result.User.Email, result.User.PublicID, expiresAt.Format("2006-01-02 15:04:05"), path)
		return err
	}
}

func loginInput(scanner *bufio.Scanner, output io.Writer, prompt string) (string, bool, error) {
	if _, err := fmt.Fprint(output, prompt); err != nil {
		return "", false, err
	}
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return "", false, fmt.Errorf("读取登录输入失败，原登录信息未修改：%w", err)
		}
		_, err := fmt.Fprintln(output, "\n已取消登录，原登录信息未修改。")
		return "", true, err
	}
	return strings.TrimSpace(scanner.Text()), false, nil
}
