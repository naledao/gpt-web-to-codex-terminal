package xyz.kangnasi.web2termback;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.cloud.openfeign.EnableFeignClients;

@EnableFeignClients
@SpringBootApplication
public class Web2TermBackApplication {

	public static void main(String[] args) {
		SpringApplication.run(Web2TermBackApplication.class, args);
	}

}